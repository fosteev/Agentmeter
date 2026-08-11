import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { attributeMarginal } from '../../attribution/marginal.ts'
import { attributePrefix } from '../../attribution/prefix.ts'
import { claudeToolFiles } from '../files.ts'
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
} from '../types.ts'

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
  /** Провайдер отметил компакт перед этим запросом записью `compact_boundary`. */
  compactMarked: boolean
  tools: ToolCall[]
  toolIds: Set<string>
  interjectedBytes: number
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
  customTitle?: string
  firstPrompt?: string
  firstRecordTs?: number
  lastRecordTs?: number
  firstAssistantTs?: number
  lastAssistantTs?: number
  drafts: Map<string, RequestDraft>
  toolResults: Map<string, ToolResult>
  lastRequestId?: string
  prefixBlocks: PrefixBlock[]
  prefixKeys: Set<string>
  prefixMemoryPaths: Set<string>
  userTurnBytes: number
  toolsDeferred: boolean
  /**
   * Видели `compact_boundary` и ещё не отдали его запросу (4.4).
   *
   * Слово провайдера сильнее вывода: где запись есть, гадать по числам не надо.
   * Пара к `compactedPending` у Codex — там компакт размечен всегда, здесь
   * только с той версии CLI, что научилась писать эту запись (на живых логах
   * она встречается один раз на 590 транскриптов).
   */
  compactPending: boolean
}

const KNOWN_RECORD_TYPES = new Set([
  'ai-title',
  'assistant',
  'custom-title',
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

const ENTRYPOINTS = new Set<Entrypoint>([
  'cli',
  'vscode',
  'jetbrains',
  'desktop',
  'sdk',
  'exec',
  'unknown',
])

export interface ParseOptions {
  /**
   * Файлы памяти, которые едут в промпт, но в логе не названы: глобальный
   * `~/.claude/CLAUDE.md` и индекс автопамяти (долг 1.7, закрыт в 4.1). Список
   * собирает `ingest` из `config.sources` — парсер, сам лезущий в домашний
   * каталог, сделал бы тесты машинозависимыми.
   *
   * Пусто (значение по умолчанию) — поведение до 4.1: эти байты остаются в
   * остатке `system`.
   */
  memoryPaths?: readonly string[]
}

export function parseSessionFile(path: string, options: ParseOptions = {}): ParseResult {
  const { lines } = readJsonlLines(path, true)
  return parseLines(path, lines, options)
}

export function parseSubagentFile(
  path: string,
  parentSessionId = parentSessionIdFromSubagentPath(path),
  options: ParseOptions = {},
): ParseResult {
  const result = parseSessionFile(path, options)
  markSubagent(result, path, parentSessionId)
  return result
}

export function parseSubagents(sessionPath: string, options: ParseOptions = {}): ParseResult[] {
  const parentId = basename(sessionPath, extname(sessionPath))
  const dirs = subagentDirs(sessionPath, parentId)
  const results: ParseResult[] = []

  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const sourcePath of subagentFiles(dir)) {
      results.push(parseSubagentFile(sourcePath, parentId, options))
    }
  }

  return results
}

function parseLines(path: string, lines: string[], options: ParseOptions): ParseResult {
  const sourcePath = resolve(path)
  const state: ParseState = {
    sourcePath,
    diagnostics: emptyDiagnostics(),
    drafts: new Map(),
    toolResults: new Map(),
    prefixBlocks: [],
    prefixKeys: new Set(),
    prefixMemoryPaths: new Set(),
    userTurnBytes: 0,
    toolsDeferred: false,
    compactPending: false,
  }

  for (const line of lines) {
    if (line.trim() === '') continue
    const record = parseRecord(line, state.diagnostics)
    if (!record) continue
    consumeRecord(state, record)
  }

  const requests = buildRequests(state)
  const session = buildSession(state, requests, options)
  attributePrefix(session, requests)
  attributeMarginal(requests, 'claude')
  return { session, requests, diagnostics: state.diagnostics }
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
    case 'attachment':
      consumeAttachment(state, record)
      return
    case 'ai-title': {
      const title = stringField(record, 'aiTitle')
      if (title) state.title = title
      return
    }
    case 'custom-title': {
      // Название, вбитое руками. Оно всегда важнее сочинённого CLI, поэтому
      // живёт отдельным полем и перебивает `ai-title` независимо от порядка
      // записей в файле.
      const title = stringField(record, 'customTitle')
      if (title) state.customTitle = title
      return
    }
    case 'last-prompt':
      if (state.firstPrompt === undefined) {
        const prompt = stringField(record, 'lastPrompt')
        if (prompt) state.firstPrompt = prompt
      }
      return
    case 'system':
      // Единственная запись, которой провайдер сам называет компакт (4.4).
      // Отдаётся следующему запросу, а не ближайшему по времени: метки времени
      // внутри файла не хронологические (2.2), а порядок записей — да.
      if (stringField(record, 'subtype') === 'compact_boundary') state.compactPending = true
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
    if (!state.diagnostics.cliVersions.includes(version))
      state.diagnostics.cliVersions.push(version)
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
  // `HEAD` — не имя ветки, а отсоединённое состояние: веткой с таким именем git
  // быть запрещает. Claude Code пишет его у 154 сессий из 461 с веткой, и без
  // отсева колонка «Проект · ветка» показывает «HEAD» у трети ленты, выдавая
  // «ветка неизвестна» за ответ (3.7).
  if (branch && branch !== 'HEAD' && state.branch === undefined) state.branch = branch

  const model = stringField(message, 'model') ?? state.model ?? 'unknown'
  if (!state.model && model !== 'unknown') state.model = model

  const ts = parseTimestamp(record) ?? 0
  state.firstAssistantTs = minDefined(state.firstAssistantTs, ts)
  state.lastAssistantTs = maxDefined(state.lastAssistantTs, ts)
  const draft = getDraft(state, requestId, ts, model, booleanField(record, 'isSidechain') ?? false)
  state.lastRequestId = requestId
  const skill = stringField(record, 'attributionSkill')
  if (skill) draft.skill = skill
  draft.isSidechain = draft.isSidechain || (booleanField(record, 'isSidechain') ?? false)

  const usage = objectField(message, 'usage')
  if (usage) {
    draft.input = Math.max(draft.input, numberField(usage, 'input_tokens') ?? 0)
    draft.output = Math.max(draft.output, numberField(usage, 'output_tokens') ?? 0)
    draft.cacheWrite = Math.max(
      draft.cacheWrite,
      numberField(usage, 'cache_creation_input_tokens') ?? 0,
    )
    draft.cacheRead = Math.max(draft.cacheRead, numberField(usage, 'cache_read_input_tokens') ?? 0)

    const cacheCreation = objectField(usage, 'cache_creation')
    const cacheWrite5m = cacheCreation
      ? numberField(cacheCreation, 'ephemeral_5m_input_tokens')
      : undefined
    const cacheWrite1h = cacheCreation
      ? numberField(cacheCreation, 'ephemeral_1h_input_tokens')
      : undefined
    if (cacheWrite5m !== undefined)
      draft.cacheWrite5m = Math.max(draft.cacheWrite5m ?? 0, cacheWrite5m)
    if (cacheWrite1h !== undefined)
      draft.cacheWrite1h = Math.max(draft.cacheWrite1h ?? 0, cacheWrite1h)
  }

  for (const block of contentBlocks(message)) {
    if (stringField(block, 'type') !== 'tool_use') continue
    const id = stringField(block, 'id')
    const name = stringField(block, 'name')
    if (!id || !name || draft.toolIds.has(id)) continue
    draft.toolIds.add(id)
    const files = claudeToolFiles(name, block.input)
    draft.tools.push({
      id,
      name,
      ...toolKind(name),
      resultBytes: 0,
      marginalTokens: 0,
      marginalBasis: 'unknown',
      hasImage: false,
      ...(files === undefined ? {} : { files }),
    })
  }
}

function consumeUser(state: ParseState, record: JsonObject): void {
  const message = objectField(record, 'message')
  if (!message) return

  const interjectedBytes = userTextBytes(message)
  if (interjectedBytes > 0 && state.drafts.size === 0) state.userTurnBytes += interjectedBytes
  if (interjectedBytes > 0 && state.lastRequestId) {
    const draft = state.drafts.get(state.lastRequestId)
    if (draft) draft.interjectedBytes += interjectedBytes
  }

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

function consumeAttachment(state: ParseState, record: JsonObject): void {
  // После первого ответа те же записи означают прирост посреди сессии. Это
  // уже маржинальная атрибуция 1.6, а не стартовый префикс.
  if (state.drafts.size > 0) return
  const attachment = objectField(record, 'attachment')
  if (!attachment) return

  switch (stringField(attachment, 'type')) {
    case 'skill_listing': {
      const content = stringField(attachment, 'content')
      if (content === undefined) return
      const listed = entries(attachment, 'names', content)
      addPrefixBlock(state, 'skills', content, undefined, listed.items, listed.names)
      return
    }
    case 'agent_listing_delta': {
      const content = stringArrayField(attachment, 'addedLines').join('\n')
      if (content === '') return
      const listed = entries(attachment, 'addedTypes', content)
      addPrefixBlock(state, 'agents', content, undefined, listed.items, listed.names)
      return
    }
    case 'deferred_tools_delta': {
      state.toolsDeferred = true
      for (const name of stringArrayField(attachment, 'addedNames')) {
        const key = `tool\u0000${name}`
        if (state.prefixKeys.has(key)) continue
        state.prefixKeys.add(key)
        const server = mcpServerFromName(name)
        state.prefixBlocks.push({
          category: server ? 'mcpTools' : 'deferredTools',
          ...(server ? { source: server } : {}),
          bytes: Buffer.byteLength(name, 'utf8'),
          tokens: 0,
          basis: 'estimated',
          items: 1,
          names: [name],
        })
      }
      return
    }
    case 'mcp_instructions_delta': {
      const names = stringArrayField(attachment, 'addedNames')
      const blocks = stringArrayField(attachment, 'addedBlocks')
      blocks.forEach((content, index) => {
        const source = names[index]
        addPrefixBlock(state, 'mcpInstructions', content, source)
      })
      return
    }
    case 'nested_memory': {
      const path = stringField(attachment, 'path')
      const content = nestedMemoryContent(attachment.content)
      // Имя файла памяти — абсолютный путь, а не `displayPath` рядом с ним:
      // тот относителен рабочему каталогу, и один файл записан в разных
      // сессиях тремя разными строками.
      if (content !== undefined)
        addPrefixBlock(state, 'memory', content, undefined, 1, path === undefined ? undefined : [resolve(path)])
      if (path !== undefined) state.prefixMemoryPaths.add(resolve(path))
      return
    }
    default:
      return
  }
}

function addPrefixBlock(
  state: ParseState,
  category: PrefixBlock['category'],
  content: string,
  source?: string,
  items = 1,
  names?: string[],
): void {
  const key = `${category}\u0000${source ?? ''}\u0000${content}`
  if (state.prefixKeys.has(key)) return
  state.prefixKeys.add(key)
  state.prefixBlocks.push({
    category,
    ...(source ? { source } : {}),
    bytes: Buffer.byteLength(content, 'utf8'),
    tokens: 0,
    basis: 'estimated',
    items,
    ...(names ? { names } : {}),
  })
}

/**
 * Что перечислено в листинге скиллов или сабагентов: имена и сколько их (4.2, 4.9).
 *
 * **Имена лежат в самом вложении массивом** — `names` у `skill_listing`,
 * `addedTypes` у `agent_listing_delta`, — и разбирать текст листинга поверх
 * этого не надо. Замер по живым логам: массив на месте у 271 сессии из 271 в
 * обоих вложениях, а его длина всегда совпадает со `skillCount` самого
 * провайдера.
 *
 * Регулярка осталась запасным путём для логов, где массива нет, и она
 * **занижает**. Формат листинга один на оба вложения, но форм в нём две и идут
 * они вперемешку — `- имя` и `- имя: описание`, — а считается только вторая.
 * Считаются при этом начала строк: маркированный список внутри описания иначе
 * насчитал бы лишних скиллов, а описания у половины из них длиной в абзац. До
 * 4.9 счёт шёл по одной регулярке, и в худшей сессии выходило 12 скиллов вместо
 * 36 (задето 7 сессий из 271, CLI 2.1.214–2.1.226). Тем запасной путь и опасен:
 * он не падает, он тихо делит на три.
 *
 * Сторож на дрейф формата — проба `breakdown-live.ts`: каждый скилл и каждый
 * сабагент, которых в этих сессиях звали, обязан найтись в листинге по имени.
 */
const LISTING_ENTRY = /^- [A-Za-z0-9][\w :.-]*: /gm

function entries(
  attachment: JsonObject,
  field: string,
  content: string,
): { items: number; names?: string[] } {
  const names = stringArrayField(attachment, field)
  if (names.length > 0) return { items: names.length, names }
  return { items: content.match(LISTING_ENTRY)?.length ?? 0 }
}

function nestedMemoryContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const content = asObject(value)
  return content ? stringField(content, 'content') : undefined
}

function mcpServerFromName(name: string): string | undefined {
  return /^mcp__(.+?)__/.exec(name)?.[1]
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
    compactMarked: state.compactPending,
    tools: [],
    toolIds: new Set(),
    interjectedBytes: 0,
  }
  state.compactPending = false
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
          interjectedBytes: 0,
          tools: [],
        })
      }
      current.compacted =
        current.compacted || looksCompacted(previous.contextTokens, current.contextTokens)
    }
    current.seq = requests.length
    requests.push(current)
    previous = current
  }

  return requests
}

/**
 * Компакт — это обвал **контекста**, а не обвал кэша (4.4).
 *
 * До 4.4 здесь стояло `cacheRead < 0.6 × (prev.cacheRead + prev.cacheWrite)`, и
 * это тот же след, который оставляет истёкший кэш: промпт переписывается
 * заново, чтение проваливается до 8–23% от прежнего префикса. Разница в том,
 * что происходит с самим промптом — при компакте разговор заменён пересказом и
 * контекст падает вместе с кэшем, при пересборке контекст остаётся на месте.
 *
 * Замер по живым логам: из 91 обвала кэша контекст сохранился у **90**
 * (отношение `ctx(N)/ctx(N−1)` в 0.95–1.05 у 77 из них), то есть прежнее
 * правило называло компактом пересборку в 90 случаях из 91 — и карточка задачи
 * писала «сжатие контекста» там, где никто ничего не сжимал.
 *
 * Ложных срабатываний у нынешнего правила ноль: падений контекста больше чем на
 * 40% при прежнем выше 10k на всех логах ровно одно, и у него есть запись
 * `compact_boundary` от самого провайдера. Порог `> 10_000` остался прежним —
 * он отсекает начало сессии, где контекст растёт с нуля рывками.
 */
function looksCompacted(previousContext: number, context: number): boolean {
  return previousContext > 10_000 && context < previousContext * 0.6
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
    compacted: draft.compactMarked,
    synthetic: false,
    interjectedBytes: draft.interjectedBytes,
    tools,
  }
  if (draft.cacheWrite5m !== undefined) request.cacheWrite5m = draft.cacheWrite5m
  if (draft.cacheWrite1h !== undefined) request.cacheWrite1h = draft.cacheWrite1h
  if (draft.skill !== undefined) request.skill = draft.skill
  return request
}

function buildSession(state: ParseState, requests: Request[], options: ParseOptions): Session {
  const loggedRequests = requests.filter((request) => request.origin === 'log')
  const firstRequest = loggedRequests[0]
  const lastRequest = loggedRequests.at(-1)
  const cwd = state.cwd ?? ''
  const prefixBlocks = [...state.prefixBlocks]
  // Корневой `CLAUDE.md` проекта и то, что дал вызывающий (глобальный
  // `CLAUDE.md`, индекс автопамяти). Одним списком, потому что правило у них
  // одно: файл считается, если его не назвал `nested_memory` и он есть на диске.
  const memoryFiles = [...(cwd ? [resolve(cwd, 'CLAUDE.md')] : []), ...(options.memoryPaths ?? [])]
  const seen = new Set<string>()
  for (const path of memoryFiles) {
    const full = resolve(path)
    if (seen.has(full) || state.prefixMemoryPaths.has(full)) continue
    seen.add(full)
    if (!existsSync(full)) continue
    prefixBlocks.push({
      category: 'memory',
      bytes: Buffer.byteLength(readFileSync(full, 'utf8'), 'utf8'),
      tokens: 0,
      basis: 'estimated',
      items: 1,
      names: [full],
    })
  }
  if (state.userTurnBytes > 0) {
    prefixBlocks.push({
      category: 'userTurn',
      bytes: state.userTurnBytes,
      tokens: 0,
      basis: 'estimated',
      items: 1,
    })
  }
  const session: Session = {
    id: state.sessionId ?? sessionIdFromPath(state.sourcePath),
    provider: 'claude',
    sourcePath: state.sourcePath,
    cwd,
    project: projectFromCwd(cwd),
    startedAt: firstRequest?.ts ?? state.firstRecordTs ?? 0,
    endedAt: state.lastAssistantTs ?? lastRequest?.ts ?? state.lastRecordTs ?? 0,
    prefixTokens: firstRequest?.contextTokens ?? 0,
    prefixBlocks,
    toolsDeferred: state.toolsDeferred,
  }
  if (state.branch !== undefined) session.branch = state.branch
  if (state.model !== undefined) session.model = state.model
  session.entrypoint = state.entrypoint ?? 'unknown'
  if (state.cliVersion !== undefined) session.cliVersion = state.cliVersion
  const title = state.customTitle ?? state.title
  if (title !== undefined) session.title = title
  if (state.firstPrompt !== undefined) session.firstPrompt = state.firstPrompt
  if (requests.length > 0 && requests.every((request) => request.isSidechain))
    session.isSidechain = true
  return session
}

/**
 * Транскрипты сабагентов лежат не только прямо в `subagents/`: у воркфлоу они
 * уходят на уровень глубже, в `subagents/workflows/wf_<id>/agent-<id>.jsonl`.
 * На диске таких файлов 220 против 150 обычных — половина расхода сабагентов,
 * которую плоский `readdir` не видел вовсе. Рядом с ними лежит `journal.jsonl`,
 * и это не транскрипт: свой словарь записей, ни одной цифры расхода. Отбор по
 * префиксу `agent-` отсекает его без разбора содержимого.
 */
function subagentFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

function subagentDirs(sessionPath: string, sessionId: string): string[] {
  const dir = dirname(sessionPath)
  const stem = basename(sessionPath, extname(sessionPath))
  return [join(dir, `${stem}.subagents`), join(dir, sessionId, 'subagents')]
}

function markSubagent(result: ParseResult, path: string, parentSessionId: string): void {
  const id = agentIdFromPath(path)
  if (id) result.session.id = id
  result.session.parentSessionId = parentSessionId
  result.session.isSidechain = true

  const meta = readMeta(`${path.slice(0, -'.jsonl'.length)}.meta.json`)
  if (meta.agentType) result.session.agentType = meta.agentType
  if (meta.toolUseId) result.session.parentToolUseId = meta.toolUseId

  for (const request of result.requests) {
    request.sessionId = result.session.id
    request.isSidechain = true
  }
}

function agentIdFromPath(path: string): string | undefined {
  const stem = basename(path, extname(path))
  return stem.startsWith('agent-') ? stem.slice('agent-'.length) : undefined
}

function parentSessionIdFromSubagentPath(path: string): string {
  const parts = resolve(path).split(/[\\/]/)
  const subagents = parts.lastIndexOf('subagents')
  const beforeSubagents = subagents > 0 ? parts[subagents - 1] : undefined
  if (beforeSubagents) return beforeSubagents

  const subagentRoot = parts.find((part) => part.endsWith('.subagents'))
  if (subagentRoot) return subagentRoot.slice(0, -'.subagents'.length)
  return basename(dirname(path)).replace(/\.subagents$/, '')
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

function userTextBytes(message: JsonObject): number {
  if (typeof message.content === 'string') return Buffer.byteLength(message.content, 'utf8')
  return contentBlocks(message).reduce((bytes, block) => {
    if (stringField(block, 'type') !== 'text') return bytes
    const text = stringField(block, 'text') ?? stringField(block, 'content')
    return bytes + (text === undefined ? 0 : Buffer.byteLength(text, 'utf8'))
  }, 0)
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

function stringArrayField(object: JsonObject, key: string): string[] {
  const value = object[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
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
