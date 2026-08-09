import { basename, extname, resolve } from 'node:path'
import { attributeMarginal } from '../../attribution/marginal.ts'
import { attributePrefix } from '../../attribution/prefix.ts'
import { appendLimitObservations } from './limits.ts'
import { readJsonlLines } from '../jsonl.ts'
import { emptyDiagnostics } from '../types.ts'
import type {
  Entrypoint,
  ParseDiagnostics,
  ParseResult,
  PrefixBlock,
  Request,
  Session,
  ToolCall,
  ToolKind,
  LimitObservation,
} from '../types.ts'

type JsonObject = Record<string, unknown>

interface PendingTool {
  id: string
  /** `undefined` — вызов начался до начала чанка, имени в этих строках нет. */
  name?: string
  order: number
  resultBytes: number
  mcpServer?: string
  mcpTool?: string
  /** Тул, чью природу видно из самой записи, а не из имени: веб-поиск. */
  kind?: ToolKind
}

/** Накопительный итог сессии. Его неподвижность — признак повторной записи. */
interface TotalUsage {
  input: number
  cached: number
  output: number
  reasoning: number
}

interface ParseState {
  sourcePath: string
  diagnostics: ParseDiagnostics
  sessionId?: string
  cwd?: string
  branch?: string
  model?: string
  currentModel?: string
  currentTurnId?: string
  cliVersion?: string
  entrypoint: Entrypoint
  title?: string
  startedAt?: number
  endedAt?: number
  contextWindow?: number
  pendingTools: Map<string, PendingTool>
  /** Уже выпущенные вызовы: результат часто приходит после `token_count`. */
  emittedTools: Map<string, ToolCall>
  pendingOrder: number
  /** Между прошлым запросом и следующим контекст сжали. */
  compactedPending: boolean
  lastTotal?: TotalUsage
  requests: Request[]
  prefixBlocks: PrefixBlock[]
  prefixMessages: Array<{ role: 'user'; bytes: number }>
  limits: LimitObservation[]
}

/**
 * Всё, что встречается в роллаутах на диске: 329 файлов, 36 версий CLI от 0.93
 * до 0.145 (`scripts/probe/codex-live.ts`). Записи из этого списка парсер может
 * игнорировать, но не считает дрейфом формата; всё остальное едет в `doctor`.
 */
const KNOWN_RECORD_TYPES = new Set([
  'compacted',
  'session_meta',
  'turn_context',
  'world_state',
  'event_msg/agent_message',
  'event_msg/agent_reasoning',
  'event_msg/context_compacted',
  'event_msg/entered_review_mode',
  'event_msg/error',
  'event_msg/exec_command_end',
  'event_msg/exited_review_mode',
  'event_msg/item_completed',
  'event_msg/mcp_tool_call_end',
  'event_msg/patch_apply_end',
  'event_msg/task_complete',
  'event_msg/task_started',
  'event_msg/thread_name_updated',
  'event_msg/token_count',
  'event_msg/turn_aborted',
  'event_msg/user_message',
  'event_msg/web_search_end',
  'response_item/custom_tool_call',
  'response_item/custom_tool_call_output',
  'response_item/function_call',
  'response_item/function_call_output',
  'response_item/message',
  'response_item/reasoning',
  'response_item/tool_search_call',
  'response_item/tool_search_output',
  'response_item/web_search_call',
])

export function parseRolloutFile(path: string): ParseResult {
  const { lines } = readJsonlLines(path, true)
  return parseLines(path, lines)
}

function parseLines(path: string, lines: string[]): ParseResult {
  const sourcePath = resolve(path)
  const state: ParseState = {
    sourcePath,
    diagnostics: emptyDiagnostics(),
    entrypoint: 'unknown',
    pendingTools: new Map(),
    emittedTools: new Map(),
    pendingOrder: 0,
    compactedPending: false,
    requests: [],
    prefixBlocks: [],
    prefixMessages: [],
    limits: [],
  }

  for (const line of lines) {
    if (line.trim() === '') continue
    const record = parseRecord(line, state.diagnostics)
    if (!record) continue
    consumeRecord(state, record)
  }

  const session = buildSession(state)
  attributePrefix(session, state.requests)
  attributeMarginal(state.requests, 'codex')
  return {
    session,
    requests: state.requests,
    diagnostics: state.diagnostics,
    limits: state.limits,
  }
}

function consumeRecord(state: ParseState, record: JsonObject): void {
  appendLimitObservations(state.limits, record)
  const type = stringField(record, 'type')
  const payload = objectField(record, 'payload')
  const key = recordTypeKey(type, payload)
  if (!KNOWN_RECORD_TYPES.has(key)) countUnknown(state.diagnostics, key)

  const ts = parseTimestamp(record)
  if (ts !== undefined) state.endedAt = ts

  switch (type) {
    case 'session_meta':
      consumeSessionMeta(state, payload)
      return
    case 'compacted':
      // Пара к `event_msg/context_compacted`: обе записи с одним timestamp
      // сообщают об одном сжатии, флаг снимет первый же следующий запрос.
      state.compactedPending = true
      return
    case 'turn_context':
      consumeTurnContext(state, payload)
      return
    case 'event_msg':
      consumeEvent(state, payload, ts)
      return
    case 'response_item':
      consumeResponseItem(state, payload)
      return
    default:
      return
  }
}

function consumeSessionMeta(state: ParseState, payload: JsonObject | undefined): void {
  if (!payload) return
  const id = stringField(payload, 'id')
  if (id) state.sessionId = id

  const cwd = stringField(payload, 'cwd')
  if (cwd) state.cwd = cwd

  const git = objectField(payload, 'git')
  const branch = git ? stringField(git, 'branch') : undefined
  if (branch) state.branch = branch

  const cliVersion = stringField(payload, 'cli_version')
  if (cliVersion) {
    state.cliVersion = cliVersion
    if (!state.diagnostics.cliVersions.includes(cliVersion))
      state.diagnostics.cliVersions.push(cliVersion)
  }

  state.entrypoint = entrypointFromOriginator(stringField(payload, 'originator'))

  const startedAt = parseTimestampValue(payload.timestamp)
  if (startedAt !== undefined) state.startedAt = startedAt

  const baseInstructions = textValue(payload.base_instructions)
  if (
    baseInstructions !== undefined &&
    !state.prefixBlocks.some((block) => block.category === 'system')
  ) {
    state.prefixBlocks.push({
      category: 'system',
      bytes: Buffer.byteLength(baseInstructions, 'utf8'),
      tokens: 0,
      basis: 'estimated',
    })
  }
}

function consumeTurnContext(state: ParseState, payload: JsonObject | undefined): void {
  if (!payload) return
  const turnId = stringField(payload, 'turn_id')
  if (turnId) state.currentTurnId = turnId

  const model = stringField(payload, 'model')
  if (!model) return
  state.currentModel = model
  if (!state.model) state.model = model
}

function consumeEvent(
  state: ParseState,
  payload: JsonObject | undefined,
  ts: number | undefined,
): void {
  if (!payload) return
  switch (stringField(payload, 'type')) {
    case 'task_started': {
      const turnId = stringField(payload, 'turn_id')
      if (turnId) state.currentTurnId = turnId
      const contextWindow = numberField(payload, 'model_context_window')
      if (contextWindow !== undefined) state.contextWindow = contextWindow
      return
    }
    case 'mcp_tool_call_end':
      consumeMcpToolCallEnd(state, payload)
      return
    case 'web_search_end': {
      // Сам `response_item/web_search_call` в большинстве версий пишется без
      // идентификатора, так что поиск заводится по записи о завершении — она
      // `call_id` несёт всегда. Результат в лог не попадает: resultBytes = 0.
      const id = stringField(payload, 'call_id')
      if (!id) return
      const emitted = state.emittedTools.get(id)
      if (emitted) {
        emitted.name = 'web_search'
        emitted.kind = 'web'
        return
      }
      const tool = getOrCreatePendingTool(state, id)
      tool.name ??= 'web_search'
      tool.kind = 'web'
      return
    }
    case 'context_compacted':
      state.compactedPending = true
      return
    case 'thread_name_updated': {
      const name = stringField(payload, 'thread_name')
      if (name) state.title = name
      return
    }
    case 'user_message': {
      const message = stringField(payload, 'message')
      const previous = state.requests.at(-1)
      if (message && previous) previous.interjectedBytes += Buffer.byteLength(message, 'utf8')
      return
    }
    case 'token_count':
      consumeTokenCount(state, payload, ts)
      return
    default:
      return
  }
}

function consumeResponseItem(state: ParseState, payload: JsonObject | undefined): void {
  if (!payload) return
  switch (stringField(payload, 'type')) {
    case 'message':
      consumePrefixMessage(state, payload)
      return
    case 'function_call':
    case 'custom_tool_call':
      consumeToolCall(state, payload)
      return
    case 'function_call_output':
    case 'custom_tool_call_output':
      consumeToolOutput(state, payload)
      return
    case 'tool_search_call': {
      // Поиск по каталогу тулов: своего `name` в записи нет, есть только тип.
      const id = stringField(payload, 'call_id')
      if (!id) return
      getOrCreatePendingTool(state, id).name ??= 'tool_search'
      return
    }
    case 'tool_search_output': {
      const id = stringField(payload, 'call_id')
      if (!id) return
      const emitted = state.emittedTools.get(id)
      if (emitted) {
        emitted.resultBytes = resultBytes(payload.tools)
        return
      }
      getOrCreatePendingTool(state, id).resultBytes = resultBytes(payload.tools)
      return
    }
    default:
      return
  }
}

function consumePrefixMessage(state: ParseState, payload: JsonObject): void {
  if (state.requests.length > 0) return
  const role = stringField(payload, 'role')
  // Служебные developer-сообщения Codex меняются вместе с рантаймом и уже
  // входят в неразложимый остаток. Из message дословно раскладываются только
  // AGENTS/memory и настоящий первый ход пользователя.
  if (role !== 'user') return
  const bytes = messageBytes(payload.content)
  if (bytes > 0) state.prefixMessages.push({ role, bytes })
}

function consumeToolCall(state: ParseState, payload: JsonObject): void {
  const id = stringField(payload, 'call_id')
  const name = stringField(payload, 'name')
  if (!id || !name) return
  const tool = getOrCreatePendingTool(state, id)
  tool.name ??= name
}

function consumeToolOutput(state: ParseState, payload: JsonObject): void {
  const id = stringField(payload, 'call_id')
  if (!id) return
  const emitted = state.emittedTools.get(id)
  if (emitted) {
    emitted.resultBytes = resultBytes(payload.output)
    if (emitted.name === 'view_image') emitted.hasImage = true
    return
  }
  const tool = getOrCreatePendingTool(state, id)
  tool.resultBytes = resultBytes(payload.output)
}

function consumeMcpToolCallEnd(state: ParseState, payload: JsonObject): void {
  const id = stringField(payload, 'call_id')
  const invocation = objectField(payload, 'invocation')
  if (!id || !invocation) return
  const server = stringField(invocation, 'server')
  const name = stringField(invocation, 'tool')
  const emitted = state.emittedTools.get(id)
  if (emitted) {
    if (server) emitted.server = server
    if (name) emitted.name = name
    emitted.kind = 'mcp'
    return
  }
  const tool = getOrCreatePendingTool(state, id)
  if (server) tool.mcpServer = server
  if (name) tool.mcpTool = name
}

function consumeTokenCount(state: ParseState, payload: JsonObject, ts: number | undefined): void {
  const info = objectField(payload, 'info')
  if (!info) return

  const lastUsage = objectField(info, 'last_token_usage')
  if (!lastUsage) return

  // Один ответ API пишется двумя `token_count` подряд — так делают не все версии
  // CLI, но на диске таких сессий 174 из 311, и наивный подсчёт завышал расход
  // почти вдвое. Отличить повтор от нового запроса даёт накопительный итог: у
  // повтора он не сдвинулся ни по одному полю. Проверено на всех роллаутах —
  // после дедупликации сумма сходится с итогом до токена (`codex-live.ts`).
  const total = totalUsage(objectField(info, 'total_token_usage'))
  if (total && state.lastTotal && sameUsage(total, state.lastTotal)) return
  if (total) state.lastTotal = total

  const inputTokens = numberField(lastUsage, 'input_tokens') ?? 0
  const cacheRead = numberField(lastUsage, 'cached_input_tokens') ?? 0
  const output = numberField(lastUsage, 'output_tokens') ?? 0
  const reasoning = numberField(lastUsage, 'reasoning_output_tokens') ?? 0
  // Размер окна берётся из самого `info`: он относится к этому запросу, тогда
  // как `task_started` мог остаться от предыдущего хода с другой моделью.
  const contextWindow = numberField(info, 'model_context_window') ?? state.contextWindow
  if (contextWindow !== undefined) state.contextWindow = contextWindow

  const request: Request = {
    sessionId: state.sessionId ?? sessionIdFromPath(state.sourcePath),
    seq: state.requests.length,
    requestId: `${state.currentTurnId ?? state.sessionId ?? sessionIdFromPath(state.sourcePath)}#${state.requests.length}`,
    ts: ts ?? 0,
    model: state.currentModel ?? state.model ?? 'unknown',
    origin: 'log',
    input: Math.max(0, inputTokens - cacheRead),
    output,
    cacheWrite: 0,
    cacheRead,
    reasoning,
    contextTokens: inputTokens,
    isSidechain: false,
    compacted: state.compactedPending,
    synthetic: false,
    interjectedBytes: 0,
    tools: pendingTools(state),
  }
  if (contextWindow !== undefined) request.contextWindow = contextWindow

  state.requests.push(request)
  state.pendingTools.clear()
  state.compactedPending = false
}

function totalUsage(usage: JsonObject | undefined): TotalUsage | undefined {
  if (!usage) return undefined
  return {
    input: numberField(usage, 'input_tokens') ?? 0,
    cached: numberField(usage, 'cached_input_tokens') ?? 0,
    output: numberField(usage, 'output_tokens') ?? 0,
    reasoning: numberField(usage, 'reasoning_output_tokens') ?? 0,
  }
}

function sameUsage(a: TotalUsage, b: TotalUsage): boolean {
  return (
    a.input === b.input &&
    a.cached === b.cached &&
    a.output === b.output &&
    a.reasoning === b.reasoning
  )
}

function pendingTools(state: ParseState): ToolCall[] {
  const tools: ToolCall[] = [...state.pendingTools.values()]
    .sort((a, b) => a.order - b.order)
    .map((tool): ToolCall => ({
      id: tool.id,
      name: tool.mcpTool ?? tool.name ?? 'unknown',
      kind: toolKind(tool),
      ...(tool.mcpServer ? { server: tool.mcpServer } : {}),
      resultBytes: tool.resultBytes,
      marginalTokens: 0,
      marginalBasis: 'unknown',
      hasImage: tool.name === 'view_image' && tool.resultBytes > 0,
    }))
  for (const tool of tools) state.emittedTools.set(tool.id, tool)
  return tools
}

function toolKind(tool: PendingTool): ToolKind {
  if (tool.mcpTool || tool.mcpServer) return 'mcp'
  if (tool.kind) return tool.kind
  return tool.name === undefined ? 'unknown' : 'builtin'
}

/**
 * Результат может прийти без своего `function_call` — чанк начался посреди хода.
 * Вызов при этом был и в промпт попал, поэтому запись заводится (иначе атрибуция
 * потеряет вес при дележе дельты), но именем становится `unknown`, а не `call_id`:
 * идентификатор в колонке «инструмент» — это выдумка, а не имя.
 */
function getOrCreatePendingTool(state: ParseState, id: string): PendingTool {
  const existing = state.pendingTools.get(id)
  if (existing) return existing
  const tool: PendingTool = { id, order: state.pendingOrder, resultBytes: 0 }
  state.pendingOrder += 1
  state.pendingTools.set(id, tool)
  return tool
}

function buildSession(state: ParseState): Session {
  const cwd = state.cwd ?? ''
  const prefixBlocks = [...state.prefixBlocks]
  const userMessages = state.prefixMessages.filter((message) => message.role === 'user')
  const userTurn = userMessages.at(-1)
  const memoryBytes = userMessages.slice(0, -1).reduce((sum, message) => sum + message.bytes, 0)
  if (memoryBytes > 0) {
    prefixBlocks.push({
      category: 'memory',
      bytes: memoryBytes,
      tokens: 0,
      basis: 'estimated',
    })
  }
  if (userTurn) {
    prefixBlocks.push({
      category: 'userTurn',
      bytes: userTurn.bytes,
      tokens: 0,
      basis: 'estimated',
    })
  }
  const session: Session = {
    id: state.sessionId ?? sessionIdFromPath(state.sourcePath),
    provider: 'codex',
    sourcePath: state.sourcePath,
    cwd,
    project: projectFromCwd(cwd),
    startedAt: state.startedAt ?? 0,
    endedAt: state.endedAt ?? 0,
    prefixTokens: state.requests.find((request) => request.origin === 'log')?.contextTokens ?? 0,
    prefixBlocks,
    toolsDeferred: false,
  }
  if (state.branch !== undefined) session.branch = state.branch
  if (state.model !== undefined) session.model = state.model
  session.entrypoint = state.entrypoint
  if (state.cliVersion !== undefined) session.cliVersion = state.cliVersion
  if (state.title !== undefined) session.title = state.title
  return session
}

function parseRecord(line: string, diagnostics: ParseDiagnostics): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return asObject(parsed)
  } catch {
    diagnostics.malformedLines += 1
    return undefined
  }
}

function recordTypeKey(type: string | undefined, payload: JsonObject | undefined): string {
  if (!type) return '<missing>'
  if (type === 'event_msg' || type === 'response_item')
    return `${type}/${stringField(payload ?? {}, 'type') ?? '<missing>'}`
  return type
}

function countUnknown(diagnostics: ParseDiagnostics, type: string): void {
  diagnostics.unknownRecordTypes[type] = (diagnostics.unknownRecordTypes[type] ?? 0) + 1
}

function resultBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (value === undefined) return 0
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function messageBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (!Array.isArray(value)) return 0
  return value.reduce((sum, item) => {
    const block = asObject(item)
    const text = block ? stringField(block, 'text') : undefined
    return sum + (text === undefined ? 0 : Buffer.byteLength(text, 'utf8'))
  }, 0)
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const object = asObject(value)
  return object ? stringField(object, 'text') : undefined
}

function entrypointFromOriginator(originator: string | undefined): Entrypoint {
  if (originator === 'codex-tui') return 'cli'
  if (originator === 'codex-exec') return 'exec'
  return 'unknown'
}

function parseTimestamp(record: JsonObject): number | undefined {
  return parseTimestampValue(record.timestamp)
}

function parseTimestampValue(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function projectFromCwd(cwd: string): string {
  return basename(cwd) || cwd
}

function sessionIdFromPath(path: string): string {
  return basename(path, extname(path))
}

function objectField(object: JsonObject, key: string): JsonObject | undefined {
  return asObject(object[key])
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}
