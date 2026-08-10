/**
 * Пересборка кэша за период — блок «Переплата за паузу» (раздел 10 макета, 4.4).
 *
 * Модель целиком — [`docs/roadmap/4.4-cache.md`](../../../../docs/roadmap/4.4-cache.md).
 * Пять вещей, которые надо помнить, читая код:
 *
 * 1. **Событие ловится разрывом цепочки кэша, а не размером записи.** Внутри
 *    сессии держится `cr(N+1) = cr(N) + cw(N)` — точное на 16 855 переходах из
 *    16 946. Недобор `cr(N−1) + cw(N−1) − cr(N) > 0` означает, что столько
 *    токенов лежало в кэше и было записано заново.
 * 2. **Цена события — `cache_write` этого запроса**, одной мерой на все четыре
 *    строки: это число сообщил провайдер, а недобор — наша разность. На живых
 *    логах недобор составляет 96.7% записи, остальное — новое содержимое,
 *    которое записалось бы в любом случае.
 * 3. **Причин четыре, и третью нельзя называть паузой.** 58 пересборок из 90
 *    объясняются паузой длиннее срока жизни кэша, а 32 случились раньше срока —
 *    причины этому в логе нет, и приписать их паузе значит соврать на треть.
 * 4. **Срок жизни кэша берётся из лога, а не из головы.** Claude Code пишет
 *    `ephemeral_1h` (96.5% записанных токенов) и `ephemeral_5m` (сабагенты).
 *    Корзины пауз — кратности этого срока, поэтому пятиминутная шкала макета и
 *    часовая живут одним правилом.
 * 5. **Итог дня от пересборок не меняется.** Те же токены едут либо чтением,
 *    либо записью, а `ctx = input + cacheWrite + cacheRead` от этого тот же.
 *    Значит складывать это число с чем-либо в шапке нельзя — оно её часть.
 */
import type { Db, SqlValue } from '../index/db.ts'
import { taskSessions } from './task.ts'
import type { DayRange, RequestScope } from './types.ts'

/** Почему кэш пересобрался. */
export type RebuildCause =
  /** Первый записанный запрос сессии: читать было нечего. */
  | 'start'
  /** Пауза длиннее срока жизни кэша. */
  | 'pause'
  /** Кэш пропал раньше срока — причина в логе не названа. */
  | 'early'
  /** Контекст сжали: прежний промпт больше не нужен. */
  | 'compact'

/** Срок жизни записи кэша, мс. Пять минут — у сабагентов, час — у сессий. */
export const CACHE_TTL_5M = 5 * 60_000
export const CACHE_TTL_1H = 60 * 60_000

/**
 * Границы корзин пауз — кратности срока жизни кэша.
 *
 * Макет (строки 1717–1745) нарисовал `5 — 10 / 10 — 30 / 30 — 60 / больше 60`
 * минут, то есть ×1–2, ×2–6, ×6–12 и дальше при пятиминутном сроке. При часовом
 * те же кратности дают 1–2 ч, 2–6 ч, 6–12 ч и больше 12 ч. Зашей мы минуты — и
 * на часовом сроке все четыре корзины оказались бы пустыми, а экран сказал бы
 * «переплаты нет» там, где её 9.5M.
 */
export const PAUSE_BUCKETS = [1, 2, 6, 12] as const

export interface RebuildEvent {
  sessionId: string
  seq: number
  ts: number
  cause: RebuildCause
  /** Токенов записано в кэш этим запросом. */
  tokens: number
  /** Из них уже лежало в кэше. У старта сессии нуль: лежать было нечему. */
  rewritten: number
  /** Пауза перед запросом, мс. `null` — первый запрос сессии, паузы нет. */
  pauseMs: number | null
  /** Срок жизни кэша, действовавший к моменту события. `null` — не записан. */
  ttlMs: number | null
  /** Где это случилось — для строки «самая дорогая пауза». */
  project: string
  branch: string | null
}

export interface RebuildGroup {
  count: number
  tokens: number
}

export interface PauseBucket {
  /** Нижняя граница в кратностях срока. Верхняя — следующая, у последней нет. */
  from: number
  to: number | null
  /** Границы в миллисекундах — по ним подписывается строка. */
  fromMs: number
  toMs: number | null
  count: number
  tokens: number
}

export interface CacheRebuildReport {
  /**
   * Есть ли в периоде запросы Claude. Нет — блока нет вовсе: у Codex
   * `cache_write` равен нулю на всех 11 994 запросах, и «ноль пересборок» было
   * бы утверждением, которого мы не делали.
   */
  measurable: boolean
  start: RebuildGroup
  pause: RebuildGroup
  early: RebuildGroup
  compact: RebuildGroup
  /** Все четыре вместе. */
  total: RebuildGroup
  /**
   * Паузы по длине. Пусто — пересборок по паузе не было; корзины с нулём в
   * список не попадают, чтобы «5 — 10 мин · 0 · 0» не читалось как измерение.
   */
  buckets: PauseBucket[]
  /**
   * События поимённо — чтобы карточка задачи могла пометить тот самый столбик
   * таймлайна. Второй раз их никто не считает: пометка и итог обязаны говорить
   * об одних и тех же запросах, иначе на экране «пересборок 3», а помечено 2.
   */
  events: RebuildEvent[]
  /** Самая дорогая пауза за период. Нет — не было ни одной. */
  worst?: RebuildEvent
  /**
   * Срок жизни кэша, которым подписан блок, мс. Ноль — сроков в логе не было.
   *
   * Берётся у **большинства** событий, а не у первого: в одном периоде живут
   * сессии с часовым сроком и сабагенты с пятиминутным, и подзаголовок обязан
   * назвать тот, про который таблица под ним. Складывать их в среднее нельзя —
   * получилось бы число, которого в логе нет.
   */
  ttlMs: number
}

interface RequestRow {
  session_id: string
  seq: number
  ts: number
  cache_write: number
  cache_read: number
  write_5m: number | null
  write_1h: number | null
  compacted: number
  provider: string
  project: string
  branch: string | null
}

type Scope = { range: DayRange; scope?: RequestScope } | { sessionId: string; range?: DayRange }

/**
 * Пересборки кэша за период либо за задачу.
 *
 * Читается **вся** сессия, а не только её кусок внутри периода, и лишь потом
 * события отсекаются по времени. Иначе первый запрос дня объявлялся бы стартом
 * сессии: задача, начатая вчера, платила бы за первую запись префикса каждое
 * утро — та же ловушка, что в 4.1 с `started_at`, и таких сессий 32 из 617.
 */
export function cacheRebuilds(db: Db, scope: Scope): CacheRebuildReport {
  const sessions = scopeSessions(db, scope)
  const range = scope.range
  const events: RebuildEvent[] = []
  let measurable = false

  for (const rows of sessions.values()) {
    if (rows[0]?.provider !== 'claude') continue
    measurable = true
    let ttlMs: number | null = null
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!
      const previous = rows[index - 1]
      const event = classify(row, previous, ttlMs)
      ttlMs = ttlOf(row) ?? ttlMs
      if (!event) continue
      if (range && (event.ts < range.from || event.ts >= range.to)) continue
      events.push(event)
    }
  }

  const pause = events.filter((event) => event.cause === 'pause')
  return {
    measurable,
    start: group(events, 'start'),
    pause: group(events, 'pause'),
    early: group(events, 'early'),
    compact: group(events, 'compact'),
    total: {
      count: events.length,
      tokens: events.reduce((sum, event) => sum + event.tokens, 0),
    },
    events,
    buckets: bucketize(pause),
    ttlMs: commonTtl(events),
    ...worst(pause),
  }
}

/**
 * Что случилось с кэшем на этом запросе.
 *
 * Порядок веток — это и есть модель, и он не переставляется: компакт назван
 * компактом, даже если перед ним была пауза (прежний промпт всё равно не
 * пригодился бы), а пауза считается только тогда, когда срок жизни кэша
 * **известен**: сравнивать паузу с придуманным сроком значит выдать догадку за
 * измерение.
 */
function classify(
  row: RequestRow,
  previous: RequestRow | undefined,
  ttlMs: number | null,
): RebuildEvent | undefined {
  if (!previous) {
    if (row.cache_write === 0) return undefined
    return {
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      cause: 'start',
      tokens: row.cache_write,
      rewritten: 0,
      pauseMs: null,
      ttlMs: ttlOf(row),
      project: row.project,
      branch: row.branch,
    }
  }
  // Событие есть, только если кэш и правда переписали. Недобор без записи
  // встречается (на живых логах один раз из 90: недобор 6093 при `cw = 0`) и
  // означает, что промпт уехал обычным вводом, а не записью в кэш. Считать его
  // пересборкой значит поставить в таблицу строку «1 раз, 0 токенов» — счёт без
  // цены, к тому же той же мерой, что у старта сессии, где запись обязательна.
  const rewritten = previous.cache_read + previous.cache_write - row.cache_read
  if (rewritten <= 0 || row.cache_write === 0) return undefined
  const pauseMs = row.ts - previous.ts
  const cause: RebuildCause =
    row.compacted === 1 ? 'compact' : ttlMs !== null && pauseMs >= ttlMs ? 'pause' : 'early'
  return {
    sessionId: row.session_id,
    seq: row.seq,
    ts: row.ts,
    cause,
    tokens: row.cache_write,
    rewritten,
    pauseMs,
    ttlMs,
    project: row.project,
    branch: row.branch,
  }
}

/** Срок, с которым этот запрос писал кэш. `null` — запрос не писал ничего. */
function ttlOf(row: RequestRow): number | null {
  if ((row.write_1h ?? 0) > 0) return CACHE_TTL_1H
  if ((row.write_5m ?? 0) > 0) return CACHE_TTL_5M
  return null
}

function group(events: RebuildEvent[], cause: RebuildCause): RebuildGroup {
  const own = events.filter((event) => event.cause === cause)
  return { count: own.length, tokens: own.reduce((sum, event) => sum + event.tokens, 0) }
}

function bucketize(events: RebuildEvent[]): PauseBucket[] {
  const buckets = PAUSE_BUCKETS.map((from, index) => ({
    from,
    to: PAUSE_BUCKETS[index + 1] ?? null,
    count: 0,
    tokens: 0,
    fromMs: 0,
    toMs: null as number | null,
  }))
  for (const event of events) {
    const ttl = event.ttlMs
    const pause = event.pauseMs
    if (ttl === null || pause === null) continue
    const ratio = pause / ttl
    const index = PAUSE_BUCKETS.reduce(
      (found, from, position) => (ratio >= from ? position : found),
      0,
    )
    const bucket = buckets[index]!
    bucket.count += 1
    bucket.tokens += event.tokens
    // Границы в миллисекундах берутся у события, а не у первого попавшегося
    // срока: в одном периоде живут и сессии, и сабагенты, то есть и часовой
    // срок, и пятиминутный. Показывается тот, по которому корзина набралась.
    bucket.fromMs = bucket.from * ttl
    bucket.toMs = bucket.to === null ? null : bucket.to * ttl
  }
  return buckets.filter((bucket) => bucket.count > 0)
}

/** Самый частый срок среди событий периода. Ноль — ни у одного его нет. */
function commonTtl(events: RebuildEvent[]): number {
  const counts = new Map<number, number>()
  for (const event of events) {
    if (event.ttlMs === null) continue
    counts.set(event.ttlMs, (counts.get(event.ttlMs) ?? 0) + 1)
  }
  let best = 0
  let seen = 0
  for (const [ttl, count] of counts) {
    if (count > seen || (count === seen && ttl > best)) {
      best = ttl
      seen = count
    }
  }
  return best
}

function worst(events: RebuildEvent[]): { worst?: RebuildEvent } {
  let found: RebuildEvent | undefined
  for (const event of events) {
    if (!found || event.tokens > found.tokens) found = event
  }
  return found ? { worst: found } : {}
}

/**
 * Запросы сессий, попавших в область, по возрастанию `seq`.
 *
 * `seq` — порядок разбора внутри файла, и он же порядок цепочки кэша; сортировка
 * по `ts` дала бы другой порядок, потому что метки времени в транскрипте не
 * хронологические (2.2), и цепочка развалилась бы на ровном месте.
 */
function scopeSessions(db: Db, scope: Scope): Map<string, RequestRow[]> {
  const filter = sessionFilter(db, scope)
  const rows = db.all<RequestRow>(
    `SELECT requests.session_id, requests.seq, requests.ts, requests.cache_write,
            requests.cache_read, requests.cache_write_5m AS write_5m,
            requests.cache_write_1h AS write_1h, requests.compacted, sessions.provider,
            sessions.project, sessions.branch
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE requests.session_id IN (${filter.sql})
     ORDER BY requests.session_id, requests.seq`,
    ...filter.params,
  )
  const grouped = new Map<string, RequestRow[]>()
  for (const row of rows) {
    const own = grouped.get(row.session_id) ?? []
    own.push(row)
    grouped.set(row.session_id, own)
  }
  return grouped
}

function sessionFilter(db: Db, scope: Scope): { sql: string; params: SqlValue[] } {
  if ('sessionId' in scope) {
    const ids = taskSessions(db, scope.sessionId)
    return { sql: ids.map(() => '?').join(', '), params: [...ids] }
  }
  const parts = ['requests.ts >= ?', 'requests.ts < ?']
  const params: SqlValue[] = [scope.range.from, scope.range.to]
  if (scope.scope?.provider) {
    parts.push('sessions.provider = ?')
    params.push(scope.scope.provider)
  }
  if (scope.scope?.project) {
    parts.push('sessions.project = ?')
    params.push(scope.scope.project)
  }
  return {
    sql: `SELECT DISTINCT requests.session_id FROM requests
          JOIN sessions ON sessions.id = requests.session_id
          WHERE ${parts.join(' AND ')}`,
    params,
  }
}
