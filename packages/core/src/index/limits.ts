import type { ClaudeLimits } from '../config/types.ts'
import { buildClaudeWindows, buildCodexWindows, type LimitRequest } from '../limits/index.ts'
import type { LimitObservation, LimitWindow, LimitWindowKind, Provider } from '../sources/types.ts'
import type { Db, SqlValue } from './db.ts'

export interface LimitWindowStats {
  observations: number
  codex: number
  claude: number
}

/** Наблюдения одного файла → индекс. Вызывается внутри транзакции putSession. */
export function putLimitObservations(
  db: Db,
  sourcePath: string,
  provider: Provider,
  observations: readonly LimitObservation[],
): void {
  for (const observation of observations) {
    db.run(
      `INSERT INTO limit_observations (
         source_path, provider, ts, window_minutes, used_percent, resets_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      sourcePath,
      provider,
      observation.ts,
      observation.windowMinutes,
      observation.usedPercent,
      observation.resetsAt,
    )
  }
}

/**
 * Пересобрать окна, если изменился **вход** сборки.
 *
 * Вход у сборки два: наблюдения с запросами в индексе (меняются при ingest) и
 * потолки с весом `cache_read` из конфига. Отпечаток последней сборки лежит в
 * `meta`, и несовпадение — единственный повод пересчитать без ingest.
 *
 * Нужно это ровно затем, чтобы `limitsReport` перестал пересобирать окна на
 * каждом чтении: при опросе трея раз в секунду это полный проход по всем
 * запросам Claude плюс скрытая запись из читающего модуля (долг 1.10). Просто
 * убрать вызов нельзя — тогда после правки потолка плана в конфиге проценты
 * замёрзли бы на `null`, и устаревший ответ выглядел бы как честное «план не
 * задан».
 */
export function ensureLimitWindows(db: Db, limits: ClaudeLimits): LimitWindowStats | null {
  const fingerprint = limitsFingerprint(limits)
  const stored = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', LIMITS_INPUT_KEY)
  if (stored?.value === fingerprint) return null
  return rebuildLimitWindows(db, limits)
}

const LIMITS_INPUT_KEY = 'limits_input'

function limitsFingerprint(limits: ClaudeLimits): string {
  return JSON.stringify([limits.fiveHourCap, limits.weeklyCap, limits.cacheReadWeight])
}

/** Полностью пересобирает окна: частичный результат здесь неизбежно врёт. */
export function rebuildLimitWindows(db: Db, limits: ClaudeLimits): LimitWindowStats {
  const observations = db.all<ObservationRow>(
    `SELECT ts, window_minutes, used_percent, resets_at
     FROM limit_observations
     WHERE provider = 'codex'`,
  )
  const codex = buildCodexWindows(observations.map(observationFromRow))
  const claude = buildClaudeWindows(readClaudeRequests(db), limits)

  db.transaction(() => {
    db.run('DELETE FROM limit_windows')
    for (const window of [...codex, ...claude]) insertWindow(db, window)
    db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      LIMITS_INPUT_KEY,
      limitsFingerprint(limits),
    )
  })

  return { observations: observations.length, codex: codex.length, claude: claude.length }
}

/**
 * Запросы Claude из индекса — вход и пересборки окон, и калибровки (1.9).
 *
 * Одной функцией, а не двумя запросами по месту: разойдись они условием (скажем,
 * один научился отбрасывать восстановленные запросы), и калибровка считала бы
 * вес по одной выборке, а окна показывали процент по другой. Провайдер
 * тарифицирует все, поэтому фильтров здесь нет.
 *
 * `from` сужает выборку по времени: калибровке нужны запросы не старше самого
 * старого окна в журнале, а это дни, а не вся история.
 */
export function readClaudeRequests(db: Db, from = 0): LimitRequest[] {
  return db
    .all<RequestRow>(
      `SELECT ts, input, output, cache_write, cache_read
       FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE sessions.provider = 'claude' AND requests.ts >= ?`,
      from,
    )
    .map(requestFromRow)
}

/** Окна из индекса, по возрастанию якоря. */
export function readLimitWindows(
  db: Db,
  opts: {
    provider?: Provider
    kind?: LimitWindowKind
    from?: number
    to?: number
  } = {},
): LimitWindow[] {
  const clauses: string[] = []
  const params: SqlValue[] = []
  if (opts.provider !== undefined) {
    clauses.push('provider = ?')
    params.push(opts.provider)
  }
  if (opts.kind !== undefined) {
    clauses.push('kind = ?')
    params.push(opts.kind)
  }
  if (opts.from !== undefined) {
    clauses.push('starts_at >= ?')
    params.push(opts.from)
  }
  if (opts.to !== undefined) {
    clauses.push('starts_at < ?')
    params.push(opts.to)
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  return db
    .all<WindowRow>(
      `SELECT provider, kind, window_minutes, starts_at, resets_at, used_percent,
              observed_at, exact, usage_input, usage_output, usage_cache_write,
              usage_cache_read, usage_weighted, usage_requests
       FROM limit_windows
       ${where}
       ORDER BY starts_at, window_minutes, resets_at`,
      ...params,
    )
    .map(windowFromRow)
}

interface ObservationRow {
  ts: number
  window_minutes: number
  used_percent: number
  resets_at: number
}

interface RequestRow {
  ts: number
  input: number
  output: number
  cache_write: number
  cache_read: number
}

interface WindowRow {
  provider: Provider
  kind: LimitWindowKind
  window_minutes: number
  starts_at: number
  resets_at: number
  used_percent: number | null
  observed_at: number
  exact: number
  usage_input: number | null
  usage_output: number | null
  usage_cache_write: number | null
  usage_cache_read: number | null
  usage_weighted: number | null
  usage_requests: number | null
}

function observationFromRow(row: ObservationRow): LimitObservation {
  return {
    ts: row.ts,
    windowMinutes: row.window_minutes,
    usedPercent: row.used_percent,
    resetsAt: row.resets_at,
  }
}

function requestFromRow(row: RequestRow): LimitRequest {
  return {
    ts: row.ts,
    input: row.input,
    output: row.output,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
  }
}

function insertWindow(db: Db, window: LimitWindow): void {
  const usage = window.usage
  db.run(
    `INSERT INTO limit_windows (
       provider, kind, window_minutes, starts_at, resets_at, used_percent,
       observed_at, exact, usage_input, usage_output, usage_cache_write,
       usage_cache_read, usage_weighted, usage_requests
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    window.provider,
    window.kind,
    window.windowMinutes,
    window.startsAt,
    window.resetsAt,
    window.usedPercent,
    window.observedAt,
    window.exact ? 1 : 0,
    usage?.input ?? null,
    usage?.output ?? null,
    usage?.cacheWrite ?? null,
    usage?.cacheRead ?? null,
    usage?.weighted ?? null,
    usage?.requests ?? null,
  )
}

function windowFromRow(row: WindowRow): LimitWindow {
  const window: LimitWindow = {
    provider: row.provider,
    kind: row.kind,
    windowMinutes: row.window_minutes,
    startsAt: row.starts_at,
    resetsAt: row.resets_at,
    usedPercent: row.used_percent,
    observedAt: row.observed_at,
    exact: row.exact === 1,
  }
  // У Codex отсутствие расхода — часть контракта, а не пустая сумма.
  if (row.usage_requests !== null) {
    window.usage = {
      input: row.usage_input!,
      output: row.usage_output!,
      cacheWrite: row.usage_cache_write!,
      cacheRead: row.usage_cache_read!,
      weighted: row.usage_weighted,
      requests: row.usage_requests,
    }
  }
  return window
}
