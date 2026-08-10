/**
 * Сбор живых агентов: кто работает, сколько потратил, когда шевелился.
 *
 * Живой слой **не разбирает логи**. Всё прочитанное лежит в индексе, его держит
 * свежим вотчер (1.5), и снимок только соединяет три дешёвых источника: реестр
 * процессов Claude, свежие роллауты Codex и агрегат из индекса. Разбор здесь
 * означал бы полный проход по файлам каждую секунду опроса трея.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Db, SqlValue } from '../index/db.ts'
import { defaultClaudeHome, defaultCodexHome } from '../index/paths.ts'
import { readLiveSessions, type ProcessStartCache } from '../sources/claude/live.ts'
import type { Entrypoint, LiveSession, Provider } from '../sources/types.ts'
import { collectContext, type ContextFill } from './context.ts'
import { DEFAULT_RATE_WINDOW_MS, observedSpan, perMinute, windowTokens } from './rate.ts'
import { deriveState, readTurn, type TurnRead } from './state.ts'
import type { LiveAgent, LiveSnapshot } from './types.ts'

export interface LiveOptions {
  claudeHome?: string
  codexHome?: string
  /**
   * Тишина, после которой агент считается простаивающим. Процесс при этом жив
   * — исчезает он только вместе с процессом.
   */
  idleMs?: number
  /**
   * Тишина, после которой роллаут Codex перестаёт считаться живым. Реестра
   * процессов у Codex нет, и это единственный доступный признак.
   */
  codexSilenceMs?: number
  /** Сколько байт хвоста читать. Не парсинг — поиск последней значимой записи. */
  tailBytes?: number
  /**
   * Сколько держать в снимке агента, чей процесс уже исчез. Макет показывает
   * такую строку гашеной, с подписью «завершился 2 мин назад» (строки 164–169),
   * поэтому смерть — не повод немедленно убрать строку из попапа.
   */
  doneGraceMs?: number
  /** Окно усреднения темпа (2.3). */
  rateWindowMs?: number
}

export const DEFAULT_LIVE_OPTIONS = {
  idleMs: 90_000,
  codexSilenceMs: 5 * 60_000,
  tailBytes: 64 * 1024,
  doneGraceMs: 5 * 60_000,
  rateWindowMs: DEFAULT_RATE_WINDOW_MS,
} as const

interface TailState {
  mtime: number
  at: number
  kind?: string
  turn?: TurnRead
}

/** Агент, которого уже нет: помним, пока не истечёт `doneGraceMs`. */
interface Remembered {
  agent: LiveAgent
  /** Первый опрос, на котором процесса не стало. `null` — ещё жив. */
  endedAt: number | null
}

/** Кэш между опросами: путь транскрипта, разобранный хвост, проверенные pid. */
export interface LiveCache {
  transcripts: Map<string, string | null>
  tails: Map<string, TailState>
  processStarts: ProcessStartCache
  recent: Map<string, Remembered>
}

export function createLiveCache(): LiveCache {
  return {
    transcripts: new Map(),
    tails: new Map(),
    processStarts: new Map(),
    recent: new Map(),
  }
}

export function collectAgents(
  db: Db,
  at: number,
  opts: LiveOptions,
  cache: LiveCache,
): LiveSnapshot {
  const idleMs = opts.idleMs ?? DEFAULT_LIVE_OPTIONS.idleMs
  const claudeHome = opts.claudeHome ?? defaultClaudeHome()
  const codexHome = opts.codexHome ?? defaultCodexHome()

  const claude = readLiveSessions(join(claudeHome, 'sessions'), cache.processStarts)
  const codex = liveCodexRollouts(
    codexHome,
    at,
    opts.codexSilenceMs ?? DEFAULT_LIVE_OPTIONS.codexSilenceMs,
  )

  const liveIds = new Set([
    ...claude.sessions.map((s) => s.sessionId),
    ...codex.map((r) => r.sessionId),
  ])
  const graveyard = harvestGone(
    cache,
    liveIds,
    at,
    opts.doneGraceMs ?? DEFAULT_LIVE_OPTIONS.doneGraceMs,
  )

  const ids = [...liveIds, ...graveyard.map((entry) => entry.agent.sessionId)]
  const meta = sessionMeta(db, ids)
  const usage = usageFor(db, ids)
  const rateWindowMs = opts.rateWindowMs ?? DEFAULT_LIVE_OPTIONS.rateWindowMs
  const recent = windowTokens(db, ids, at - rateWindowMs, at)
  // Контекст — по собственному id сессии, без свёртки сабагентов: у сабагента
  // своё окно, и подмешать его в родителя значит показать чужой контекст.
  const context = collectContext(db, ids, at)

  const agents: LiveAgent[] = []

  for (const session of claude.sessions) {
    const path =
      meta.get(session.sessionId)?.sourcePath ?? resolveClaudeTranscript(claudeHome, session, cache)
    agents.push(
      buildAgent({
        sessionId: session.sessionId,
        provider: 'claude',
        pid: session.pid,
        cwd: session.cwd,
        entrypoint: session.entrypoint,
        startedAt: session.startedAt,
        cliVersion: session.cliVersion,
        name: session.name,
        transcript: path,
        liveness: 'process',
        at,
        idleMs,
        opts,
        cache,
        meta,
        usage,
        recent,
        context,
        rateWindowMs,
      }),
    )
  }

  for (const rollout of codex) {
    agents.push(
      buildAgent({
        sessionId: rollout.sessionId,
        provider: 'codex',
        pid: null,
        cwd: meta.get(rollout.sessionId)?.cwd ?? '',
        entrypoint: meta.get(rollout.sessionId)?.entrypoint ?? 'unknown',
        startedAt: meta.get(rollout.sessionId)?.startedAt ?? rollout.mtime,
        transcript: rollout.path,
        liveness: 'silence',
        at,
        idleMs,
        opts,
        cache,
        meta,
        usage,
        recent,
        context,
        rateWindowMs,
      }),
    )
  }

  for (const agent of agents) cache.recent.set(agent.sessionId, { agent, endedAt: null })

  // Завершившиеся собираются после живых: их расход берётся из индекса заново
  // — последний кусок транскрипта вотчер дочитывает уже после смерти процесса,
  // и замороженное число было бы меньше настоящего.
  for (const entry of graveyard) {
    agents.push(
      doneAgent(entry, usage.get(entry.agent.sessionId), context.get(entry.agent.sessionId)),
    )
  }

  forgetGone(
    cache,
    agents.map((agent) => agent.sessionId),
  )

  return {
    at,
    agents: agents.sort((a, b) => a.startedAt - b.startedAt),
    warnings: claude.warnings,
  }
}

/**
 * Кого уже нет, но кого ещё показываем.
 *
 * Момент смерти ставится один раз — на первом опросе, где процесса не стало.
 * Пересчитывать его от текущего опроса нельзя: строка «завершился 2 мин назад»
 * навсегда осталась бы «завершился только что».
 */
function harvestGone(
  cache: LiveCache,
  liveIds: ReadonlySet<string>,
  at: number,
  graceMs: number,
): Array<{ agent: LiveAgent; endedAt: number }> {
  const out: Array<{ agent: LiveAgent; endedAt: number }> = []
  for (const [sessionId, entry] of cache.recent) {
    if (liveIds.has(sessionId)) continue
    const endedAt = entry.endedAt ?? at
    if (at - endedAt > graceMs) {
      cache.recent.delete(sessionId)
      continue
    }
    entry.endedAt = endedAt
    out.push({ agent: entry.agent, endedAt })
  }
  return out
}

function doneAgent(
  entry: { agent: LiveAgent; endedAt: number },
  usage: Usage | undefined,
  context: ContextFill | undefined,
): LiveAgent {
  const agent: LiveAgent = {
    ...entry.agent,
    state: 'done',
    endedAt: entry.endedAt,
    // Темп мёртвого агента — ноль, а не последний замеренный: «жжёт 40k/мин»
    // под строкой «завершился» читается как «всё ещё жжёт».
    rate: 0,
  }
  if (usage !== undefined) {
    agent.tokens = usage.tokens
    agent.requests = usage.requests
    agent.approximate = usage.reconstructed > 0
    agent.lastRequestTs = usage.lastRequestTs
  }
  // Контекст перечитывается по той же причине, что и расход: последний кусок
  // транскрипта вотчер дочитывает уже после смерти процесса.
  if (context !== undefined) agent.context = context
  return agent
}

interface BuildInput {
  sessionId: string
  provider: Provider
  pid: number | null
  cwd: string
  entrypoint: Entrypoint
  startedAt: number
  cliVersion?: string | undefined
  name?: string | undefined
  transcript: string | null
  liveness: LiveAgent['liveness']
  at: number
  idleMs: number
  opts: LiveOptions
  cache: LiveCache
  meta: Map<string, SessionMeta>
  usage: Map<string, Usage>
  recent: Map<string, number>
  context: Map<string, ContextFill>
  rateWindowMs: number
}

function buildAgent(input: BuildInput): LiveAgent {
  const meta = input.meta.get(input.sessionId)
  const usage = input.usage.get(input.sessionId)
  const tail = input.transcript
    ? readTail(
        input.transcript,
        input.provider,
        input.opts.tailBytes ?? DEFAULT_LIVE_OPTIONS.tailBytes,
        input.cache,
      )
    : undefined

  // Момент активности берётся из последней записи транскрипта, а не из mtime
  // файла сессии: тот пишется один раз при старте процесса и не двигается
  // никогда (проверено на всех девяти файлах живой машины).
  const lastActivityAt = Math.max(
    tail?.at ?? 0,
    usage?.lastRequestTs ?? 0,
    meta?.endedAt ?? 0,
    input.startedAt,
  )

  const agent: LiveAgent = {
    sessionId: input.sessionId,
    provider: input.provider,
    pid: input.pid,
    project: meta?.project ?? projectFromCwd(input.cwd),
    cwd: input.cwd || (meta?.cwd ?? ''),
    entrypoint: input.entrypoint === 'unknown' ? (meta?.entrypoint ?? 'unknown') : input.entrypoint,
    startedAt: input.startedAt,
    lastActivityAt,
    state: deriveState({
      at: input.at,
      lastActivityAt,
      idleMs: input.idleMs,
      turn: tail?.turn?.kind,
      alive: true,
    }),
    tokens: usage?.tokens ?? 0,
    requests: usage?.requests ?? 0,
    rate: perMinute(
      input.recent.get(input.sessionId) ?? 0,
      observedSpan(input.at, input.startedAt, input.rateWindowMs),
    ),
    approximate: (usage?.reconstructed ?? 0) > 0,
    liveness: input.liveness,
  }
  if (usage !== undefined) agent.lastRequestTs = usage.lastRequestTs
  const context = input.context.get(input.sessionId)
  if (context !== undefined) agent.context = context
  if (meta?.branch) agent.branch = meta.branch
  if (meta?.model) agent.model = meta.model
  if (input.cliVersion !== undefined) agent.cliVersion = input.cliVersion
  else if (meta?.cliVersion) agent.cliVersion = meta.cliVersion
  if (input.name !== undefined) agent.name = input.name
  if (tail?.kind !== undefined) agent.lastEventKind = tail.kind
  if (tail?.turn !== undefined) {
    agent.turn = tail.turn.kind
    if (tail.turn.tool !== undefined) agent.pendingTool = tail.turn.tool
  }
  return agent
}

interface SessionMeta {
  sourcePath: string
  cwd: string
  project: string
  branch: string | null
  model: string | null
  entrypoint: Entrypoint | null
  cliVersion: string | null
  startedAt: number
  endedAt: number
}

function sessionMeta(db: Db, ids: readonly string[]): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>()
  if (ids.length === 0) return out
  const rows = db.all<{
    id: string
    source_path: string
    cwd: string
    project: string
    branch: string | null
    model: string | null
    entrypoint: string | null
    cli_version: string | null
    started_at: number
    ended_at: number
  }>(
    `SELECT id, source_path, cwd, project, branch, model, entrypoint, cli_version,
            started_at, ended_at
     FROM sessions
     WHERE id IN (${placeholders(ids.length)})`,
    ...(ids as SqlValue[]),
  )
  for (const row of rows) {
    out.set(row.id, {
      sourcePath: row.source_path,
      cwd: row.cwd,
      project: row.project,
      branch: row.branch,
      model: row.model,
      entrypoint: (row.entrypoint as Entrypoint | null) ?? null,
      cliVersion: row.cli_version,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    })
  }
  return out
}

interface Usage {
  tokens: number
  requests: number
  reconstructed: number
  lastRequestTs: number
}

/**
 * Расход живых сессий вместе с их сабагентами.
 *
 * Сабагент — не отдельный агент в трее: своего процесса у него нет, а его
 * транскрипт лежит в индексе отдельной сессией (так и надо, 1.3). Свёртка идёт
 * по `parent_session_id` прямо в запросе, иначе один работающий агент
 * показывается пятью и число в шапке попапа врёт.
 */
function usageFor(db: Db, ids: readonly string[]): Map<string, Usage> {
  const out = new Map<string, Usage>()
  if (ids.length === 0) return out
  const rows = db.all<{
    key: string
    tokens: number
    requests: number
    reconstructed: number
    last_ts: number
  }>(
    `SELECT coalesce(sessions.parent_session_id, sessions.id) AS key,
            sum(requests.input + requests.output + requests.cache_write + requests.cache_read) AS tokens,
            count(*) AS requests,
            coalesce(sum(requests.origin != 'log'), 0) AS reconstructed,
            max(requests.ts) AS last_ts
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE coalesce(sessions.parent_session_id, sessions.id) IN (${placeholders(ids.length)})
     GROUP BY key`,
    ...(ids as SqlValue[]),
  )
  for (const row of rows) {
    out.set(row.key, {
      tokens: row.tokens,
      requests: row.requests,
      reconstructed: row.reconstructed,
      lastRequestTs: row.last_ts,
    })
  }
  return out
}

interface CodexRollout {
  sessionId: string
  path: string
  mtime: number
}

const ROLLOUT_NAME =
  /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Живые сессии Codex — по свежести роллаута.
 *
 * Реестра процессов у Codex нет: проверено по всему `~/.codex`, включая
 * `process_manager/`, `ipc/` и `session_index.jsonl` — ни pid, ни признака
 * жизни там нет. Поэтому «жив» здесь означает «писал недавно», и наружу это
 * помечено как догадка (`liveness: 'silence'`).
 *
 * Обходятся три каталога дат вокруг текущего, а не всё дерево: роллаутов на
 * диске сотни, и рекурсивный обход каждую секунду опроса не нужен ни за чем.
 */
function liveCodexRollouts(codexHome: string, at: number, silenceMs: number): CodexRollout[] {
  const out: CodexRollout[] = []
  const root = join(codexHome, 'sessions')
  if (!existsSync(root)) return out

  for (const dir of dayDirs(root, at)) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const sessionId = ROLLOUT_NAME.exec(name)?.[1]
      if (sessionId === undefined) continue
      const path = join(dir, name)
      try {
        const stat = statSync(path)
        if (at - stat.mtimeMs > silenceMs) continue
        out.push({ sessionId: sessionId.toLowerCase(), path, mtime: stat.mtimeMs })
      } catch {
        // Файл исчез между листингом и stat — обычное дело при чистке логов.
      }
    }
  }
  return out
}

/** Вчера, сегодня и завтра по местному времени — запас на границу зоны. */
function dayDirs(root: string, at: number): string[] {
  const dirs: string[] = []
  for (const offset of [-1, 0, 1]) {
    const date = new Date(at)
    date.setDate(date.getDate() + offset)
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const dir = join(root, year, month, day)
    if (existsSync(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * Путь транскрипта сессии, которой ещё нет в индексе.
 *
 * Сначала догадка по слагу каталога (Claude Code заменяет разделители пути на
 * дефис), потом — разовый обход каталогов проектов. Результат кэшируется
 * вместе с отрицательным: новая сессия появляется в реестре раньше, чем её
 * файл, и искать его каждую секунду незачем.
 */
function resolveClaudeTranscript(
  claudeHome: string,
  session: LiveSession,
  cache: LiveCache,
): string | null {
  const cached = cache.transcripts.get(session.sessionId)
  if (cached !== undefined) return cached

  const projects = join(claudeHome, 'projects')
  const guess = join(projects, slugFromCwd(session.cwd), `${session.sessionId}.jsonl`)
  if (existsSync(guess)) {
    cache.transcripts.set(session.sessionId, guess)
    return guess
  }

  let found: string | null = null
  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(projects, entry.name, `${session.sessionId}.jsonl`)
      if (existsSync(path)) {
        found = path
        break
      }
    }
  } catch {
    found = null
  }
  cache.transcripts.set(session.sessionId, found)
  return found
}

function slugFromCwd(cwd: string): string {
  return cwd.replace(/[/\\.:_]/g, '-')
}

function projectFromCwd(cwd: string): string {
  return basename(cwd) || cwd
}

/**
 * Хвост транскрипта: последняя запись и чей сейчас ход. Читается не более
 * `bytes` с конца и **только при сдвинувшемся mtime**: без второго условия
 * десяток живых сессий при опросе раз в секунду даёт постоянные сотни
 * килобайт чтения ни за чем.
 */
function readTail(
  path: string,
  provider: Provider,
  bytes: number,
  cache: LiveCache,
): TailState | undefined {
  let size: number
  let mtime: number
  try {
    const stat = statSync(path)
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return undefined
  }

  const cached = cache.tails.get(path)
  if (cached && cached.mtime === mtime) return cached

  const length = Math.min(bytes, size)
  if (length === 0) return undefined
  const buffer = Buffer.allocUnsafe(length)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, size - length)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  const all = buffer.toString('utf8').split('\n')
  // Первая строка куска почти всегда обрезана посередине — её выбрасываем,
  // если читали не с начала файла.
  const lines = length < size ? all.slice(1) : all

  const state: TailState = { mtime, at: mtime }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    const parsed = parseRecord(line)
    if (!parsed) continue
    state.at = parsed.at ?? mtime
    if (parsed.kind !== undefined) state.kind = parsed.kind
    break
  }

  // Ход ищется по всему куску, а не по последней записи: после значимой записи
  // в лог ложатся учётные, и «тип последней записи» отвечает про них (2.2).
  const turn = readTurn(provider, lines)
  if (turn !== undefined) state.turn = turn

  cache.tails.set(path, state)
  return state
}

function parseRecord(line: string): { at?: number; kind?: string } | undefined {
  try {
    const raw: unknown = JSON.parse(line)
    if (typeof raw !== 'object' || raw === null) return undefined
    const value = raw as Record<string, unknown>
    const out: { at?: number; kind?: string } = {}
    // `timestamp` у Claude, `ts` у Codex — формат другой, поле другое.
    const ts = value['timestamp'] ?? value['ts']
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts)
      if (!Number.isNaN(parsed)) out.at = parsed
    } else if (typeof ts === 'number' && Number.isFinite(ts)) {
      out.at = ts
    }
    // У Codex `type` — это `event_msg`/`response_item` на всех записях подряд,
    // а разбирать надо `payload.type`: он и есть вид события.
    const payload = value['payload']
    const inner =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)['type']
        : undefined
    if (typeof inner === 'string') out.kind = inner
    else if (typeof value['type'] === 'string') out.kind = value['type']
    return out
  } catch {
    return undefined
  }
}

function forgetGone(cache: LiveCache, alive: readonly string[]): void {
  const set = new Set(alive)
  for (const id of [...cache.transcripts.keys()]) {
    if (!set.has(id)) cache.transcripts.delete(id)
  }
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}
