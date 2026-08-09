import { existsSync, openSync, readFileSync, readSync, readdirSync, closeSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { emptyDiagnostics } from '../types.ts'
import type { Entrypoint, ParseDiagnostics, ParseResult, Request, Session, ToolCall, ToolKind } from '../types.ts'

type JsonObject = Record<string, unknown>

interface RequestDraft {
  requestId: string
  ts: number
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  skill?: string
  isSidechain: boolean
  tools: ToolCall[]
  toolIds: Set<string>
}

interface ToolResult {
  resultBytes: number
  hasImage: boolean
}

interface ParseState {
  sourcePath: string
  diagnostics: ParseDiagnostics
  sessionId?: string
  cwd?: string
  branch?: string
  model?: string
  entrypoint?: Entrypoint
  cliVersion?: string
  title?: string
  firstPrompt?: string
  firstRecordTs?: number
  lastRecordTs?: number
  firstAssistantTs?: number
  lastAssistantTs?: number
  drafts: Map<string, RequestDraft>
  toolResults: Map<string, ToolResult>
}

const KNOWN_RECORD_TYPES = new Set([
  'ai-title',
  'assistant',
  'attachment',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
  'summary',
  'system',
  'user',
])

const ENTRYPOINTS = new Set<Entrypoint>(['cli', 'vscode', 'jetbrains', 'desktop', 'sdk', 'exec', 'unknown'])

export function parseSessionFile(path: string): ParseResult {
  const { lines } = readJsonlLines(path, 0, true)
  return parseLines(path, lines)
}

export function parseSessionChunk(path: string, fromOffset: number): { requests: Request[]; offset: number } {
  const { lines, offset } = readJsonlLines(path, fromOffset, false)
  return { requests: parseLines(path, lines).requests, offset }
}

export function parseSubagents(sessionPath: string): ParseResult[] {
  const parent = parseSessionFile(sessionPath).session
  const dirs = subagentDirs(sessionPath, parent.id)
  const results: ParseResult[] = []

  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort((a, b) => a.localeCompare(b))
    for (const file of files) {
      const sourcePath = join(dir, file)
      const result = parseSessionFile(sourcePath)
      const meta = readMeta(join(dir, `${basename(file, '.jsonl')}.meta.json`))
      result.session.parentSessionId = parent.id
      result.session.isSidechain = true
      if (meta.agentType) result.session.agentType = meta.agentType
      if (meta.toolUseId) result.session.parentToolUseId = meta.toolUseId
      results.push(result)
    }
  }

  return results
}

function parseLines(path: string, lines: string[]): ParseResult {
  const sourcePath = resolve(path)
  const state: ParseState = {
    sourcePath,
    diagnostics: emptyDiagnostics(),
    drafts: new Map(),
    toolResults: new Map(),
  }

  for (const line of lines) {
    if (line.trim() === '') continue
    const record = parseRecord(line, state.diagnostics)
    if (!record) continue
    consumeRecord(state, record)
  }

  const requests = buildRequests(state)
  const session = buildSession(state, requests)
  return { session, requests, diagnostics: state.diagnostics }
}

function readJsonlLines(
  path: string,
  fromOffset: number,
  includeTrailingLine: boolean,
): { lines: string[]; offset: number } {
  const fd = openSync(path, 'r')
  const lines: string[] = []
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let carry = Buffer.alloc(0)
  let fileOffset = fromOffset
  let completeOffset = fromOffset

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, fileOffset)
      if (bytesRead === 0) break
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      const dataStartOffset = fileOffset - carry.length
      fileOffset += bytesRead

      let start = 0
      for (let i = 0; i < data.length; i += 1) {
        if (data[i] !== 0x0a) continue
        const end = i > start && data[i - 1] === 0x0d ? i - 1 : i
        lines.push(data.subarray(start, end).toString('utf8'))
        completeOffset = dataStartOffset + i + 1
        start = i + 1
      }
      carry = Buffer.from(data.subarray(start))
    }

    if (includeTrailingLine && carry.length > 0) {
      lines.push(carry.toString('utf8'))
      completeOffset = fileOffset
    }
  } finally {
    closeSync(fd)
  }

  return { lines, offset: completeOffset }
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

function consumeRecord(state: ParseState, record: JsonObject): void {
  const type = stringField(record, 'type')
  if (!type) {
    countUnknown(state.diagnostics, '<missing>')
    return
  }
  if (!KNOWN_RECORD_TYPES.has(type)) countUnknown(state.diagnostics, type)

  consumeCommonSessionFields(state, record)

  switch (type) {
    case 'assistant':
      consumeAssistant(state, record)
      return
    case 'user':
      consumeUser(state, record)
      return
    case 'ai-title': {
      const title = stringField(record, 'aiTitle')
      if (title) state.title = title
      return
    }
    case 'last-prompt':
      if (state.firstPrompt === undefined) {
        const prompt = stringField(record, 'lastPrompt')
        if (prompt) state.firstPrompt = prompt
      }
      return
    default:
      return
  }
}

function consumeCommonSessionFields(state: ParseState, record: JsonObject): void {
  const sessionId = stringField(record, 'sessionId')
  if (sessionId && !state.sessionId) state.sessionId = sessionId

  const version = stringField(record, 'version')
  if (version) {
    if (!state.cliVersion) state.cliVersion = version
    if (!state.diagnostics.cliVersions.includes(version)) state.diagnostics.cliVersions.push(version)
  }

  const entrypoint = stringField(record, 'entrypoint')
  if (isEntrypoint(entrypoint)) state.entrypoint = entrypoint

  const ts = parseTimestamp(record)
  if (ts !== undefined) {
    state.firstRecordTs = minDefined(state.firstRecordTs, ts)
    state.lastRecordTs = maxDefined(state.lastRecordTs, ts)
  }
}

function consumeAssistant(state: ParseState, record: JsonObject): void {
  const requestId = stringField(record, 'requestId')
  const message = objectField(record, 'message')
  if (!requestId || !message) return

  const cwd = stringField(record, 'cwd')
  if (cwd && state.cwd === undefined) state.cwd = cwd

  const branch = stringField(record, 'gitBranch')
  if (branch && state.branch === undefined) state.branch = branch

  const model = stringField(message, 'model') ?? state.model ?? 'unknown'
  if (!state.model && model !== 'unknown') state.model = model

  const ts = parseTimestamp(record) ?? 0
  state.firstAssistantTs = minDefined(state.firstAssistantTs, ts)
  state.lastAssistantTs = maxDefined(state.lastAssistantTs, ts)
  const draft = getDraft(state, requestId, ts, model, booleanField(record, 'isSidechain') ?? false)
  const skill = stringField(record, 'attributionSkill')
  if (skill) draft.skill = skill
  draft.isSidechain = draft.isSidechain || (booleanField(record, 'isSidechain') ?? false)

  const usage = objectField(message, 'usage')
  if (usage) {
    draft.input = Math.max(draft.input, numberField(usage, 'input_tokens') ?? 0)
    draft.output = Math.max(draft.output, numberField(usage, 'output_tokens') ?? 0)
    draft.cacheWrite = Math.max(draft.cacheWrite, numberField(usage, 'cache_creation_input_tokens') ?? 0)
    draft.cacheRead = Math.max(draft.cacheRead, numberField(usage, 'cache_read_input_tokens') ?? 0)

    const cacheCreation = objectField(usage, 'cache_creation')
    const cacheWrite5m = cacheCreation ? numberField(cacheCreation, 'ephemeral_5m_input_tokens') : undefined
    const cacheWrite1h = cacheCreation ? numberField(cacheCreation, 'ephemeral_1h_input_tokens') : undefined
    if (cacheWrite5m !== undefined) draft.cacheWrite5m = Math.max(draft.cacheWrite5m ?? 0, cacheWrite5m)
    if (cacheWrite1h !== undefined) draft.cacheWrite1h = Math.max(draft.cacheWrite1h ?? 0, cacheWrite1h)
  }

  for (const block of contentBlocks(message)) {
    if (stringField(block, 'type') !== 'tool_use') continue
    const id = stringField(block, 'id')
    const name = stringField(block, 'name')
    if (!id || !name || draft.toolIds.has(id)) continue
    draft.toolIds.add(id)
    draft.tools.push({
      id,
      name,
      ...toolKind(name),
      resultBytes: 0,
      marginalTokens: 0,
      hasImage: false,
    })
  }
}

function consumeUser(state: ParseState, record: JsonObject): void {
  const message = objectField(record, 'message')
  if (!message) return

  for (const block of contentBlocks(message)) {
    if (stringField(block, 'type') !== 'tool_result') continue
    const id = stringField(block, 'tool_use_id')
    if (!id) continue
    const resultSource = 'toolUseResult' in record ? record.toolUseResult : block.content
    const resultBytes = JSON.stringify(resultSource).length
    const hasImage = valueHasImage(resultSource) || valueHasImage(block.content)
    state.toolResults.set(id, { resultBytes, hasImage })
  }
}

function getDraft(
  state: ParseState,
  requestId: string,
  ts: number,
  model: string,
  isSidechain: boolean,
): RequestDraft {
  const existing = state.drafts.get(requestId)
  if (existing) return existing
  const draft: RequestDraft = {
    requestId,
    ts,
    model,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    isSidechain,
    tools: [],
    toolIds: new Set(),
  }
  state.drafts.set(requestId, draft)
  return draft
}

function buildRequests(state: ParseState): Request[] {
  const requests: Request[] = []
  let previous: Request | undefined

  for (const draft of state.drafts.values()) {
    const current = requestFromDraft(state, draft)
    if (previous) {
      const expectedCacheRead = previous.cacheRead + previous.cacheWrite
      if (current.cacheRead > expectedCacheRead) {
        requests.push({
          sessionId: current.sessionId,
          seq: requests.length,
          requestId: `reconstructed:${previous.requestId}`,
          ts: previous.ts,
          model: previous.model,
          origin: 'reconstructed',
          input: 0,
          output: 0,
          cacheWrite: current.cacheRead - expectedCacheRead,
          cacheRead: expectedCacheRead,
          contextTokens: current.cacheRead,
          isSidechain: previous.isSidechain,
          compacted: false,
          synthetic: true,
          tools: [],
        })
      }
      current.compacted = looksCompacted(expectedCacheRead, current.cacheRead)
    }
    current.seq = requests.length
    requests.push(current)
    previous = current
  }

  return requests
}

/**
 * Компакт — это обвал префикса, а не любое его уменьшение.
 *
 * Кэш живёт своей жизнью: часть префикса может не дочитаться и без сжатия
 * контекста, и такие мелкие просадки компактом называть нельзя — иначе
 * «контекст сжали» будет написано там, где ничего не сжимали. На живых логах
 * все настоящие компакты роняют префикс до 8–23% от прежнего.
 */
function looksCompacted(previousPrefix: number, cacheRead: number): boolean {
  return previousPrefix > 10_000 && cacheRead < previousPrefix * 0.6
}

function requestFromDraft(state: ParseState, draft: RequestDraft): Request {
  const tools = draft.tools.map((tool) => {
    const result = state.toolResults.get(tool.id)
    return {
      ...tool,
      resultBytes: result?.resultBytes ?? 0,
      hasImage: result?.hasImage ?? false,
    }
  })

  const request: Request = {
    sessionId: state.sessionId ?? sessionIdFromPath(state.sourcePath),
    seq: 0,
    requestId: draft.requestId,
    ts: draft.ts,
    model: draft.model,
    origin: 'log',
    input: draft.input,
    output: draft.output,
    cacheWrite: draft.cacheWrite,
    cacheRead: draft.cacheRead,
    contextTokens: draft.input + draft.cacheRead + draft.cacheWrite,
    isSidechain: draft.isSidechain,
    compacted: false,
    synthetic: false,
    tools,
  }
  if (draft.cacheWrite5m !== undefined) request.cacheWrite5m = draft.cacheWrite5m
  if (draft.cacheWrite1h !== undefined) request.cacheWrite1h = draft.cacheWrite1h
  if (draft.skill !== undefined) request.skill = draft.skill
  return request
}

function buildSession(state: ParseState, requests: Request[]): Session {
  const loggedRequests = requests.filter((request) => request.origin === 'log')
  const firstRequest = loggedRequests[0]
  const lastRequest = loggedRequests.at(-1)
  const cwd = state.cwd ?? ''
  const session: Session = {
    id: state.sessionId ?? sessionIdFromPath(state.sourcePath),
    provider: 'claude',
    sourcePath: state.sourcePath,
    cwd,
    project: projectFromCwd(cwd),
    startedAt: firstRequest?.ts ?? state.firstRecordTs ?? 0,
    endedAt: state.lastAssistantTs ?? lastRequest?.ts ?? state.lastRecordTs ?? 0,
  }
  if (state.branch !== undefined) session.branch = state.branch
  if (state.model !== undefined) session.model = state.model
  session.entrypoint = state.entrypoint ?? 'unknown'
  if (state.cliVersion !== undefined) session.cliVersion = state.cliVersion
  if (state.title !== undefined) session.title = state.title
  if (state.firstPrompt !== undefined) session.firstPrompt = state.firstPrompt
  if (requests.length > 0 && requests.every((request) => request.isSidechain)) session.isSidechain = true
  return session
}

function subagentDirs(sessionPath: string, sessionId: string): string[] {
  const dir = dirname(sessionPath)
  const stem = basename(sessionPath, extname(sessionPath))
  return [join(dir, `${stem}.subagents`), join(dir, sessionId, 'subagents')]
}

function readMeta(path: string): { agentType?: string; toolUseId?: string } {
  if (!existsSync(path)) return {}
  try {
    const meta = asObject(JSON.parse(readFileSync(path, 'utf8')))
    if (!meta) return {}
    const result: { agentType?: string; toolUseId?: string } = {}
    const agentType = stringField(meta, 'agentType')
    const toolUseId = stringField(meta, 'toolUseId')
    if (agentType !== undefined) result.agentType = agentType
    if (toolUseId !== undefined) result.toolUseId = toolUseId
    return result
  } catch {
    return {}
  }
}

function countUnknown(diagnostics: ParseDiagnostics, type: string): void {
  diagnostics.unknownRecordTypes[type] = (diagnostics.unknownRecordTypes[type] ?? 0) + 1
}

function parseTimestamp(record: JsonObject): number | undefined {
  const timestamp = stringField(record, 'timestamp')
  if (!timestamp) return undefined
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? undefined : parsed
}

function contentBlocks(message: JsonObject): JsonObject[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const object = asObject(block)
    return object ? [object] : []
  })
}

function valueHasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => valueHasImage(item))
  const object = asObject(value)
  if (!object) return false
  if (object.type === 'image' || object.isImage === true) return true
  return Object.values(object).some((item) => valueHasImage(item))
}

function toolKind(name: string): { kind: ToolKind; server?: string } {
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name)
  const server = mcp?.[1]
  if (server) return { kind: 'mcp', server }
  if (name === 'Agent' || name === 'Task') return { kind: 'agent' }
  if (name === 'Skill') return { kind: 'skill' }
  if (name === 'WebSearch' || name === 'WebFetch') return { kind: 'web' }
  return { kind: 'builtin' }
}

function projectFromCwd(cwd: string): string {
  return basename(cwd) || cwd
}

function sessionIdFromPath(path: string): string {
  return basename(path, extname(path))
}

function minDefined(a: number | undefined, b: number): number {
  return a === undefined ? b : Math.min(a, b)
}

function maxDefined(a: number | undefined, b: number): number {
  return a === undefined ? b : Math.max(a, b)
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

function booleanField(object: JsonObject, key: string): boolean | undefined {
  const value = object[key]
  return typeof value === 'boolean' ? value : undefined
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}

function isEntrypoint(value: string | undefined): value is Entrypoint {
  return value !== undefined && ENTRYPOINTS.has(value as Entrypoint)
}
