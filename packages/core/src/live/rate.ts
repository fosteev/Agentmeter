/**
 * Темп расхода — этап 2.3. В макете этого нет: строится поверх готовых
 * компонентов, второй строкой `AgentRow` и подписью к `LimitBar`.
 *
 * Темп — это всегда «за какое-то время», и всё враньё прячется в знаменателе.
 * Здесь два правила, оба про него.
 *
 * Первое: **окно усреднения обрезается возрастом**. Сессия, прожившая
 * двадцать секунд и сделавшая один запрос на 200k, при делении на пять минут
 * покажет 40k/мин, а при делении на её собственные двадцать секунд — 600k/мин.
 * Правдивее второе, но и оно бессмысленно: одна точка темпа не образует.
 * Поэтому знаменатель — возраст, обрезанный сверху окном и снизу полом
 * (`floorMs`), а всё, что моложе пола, темпа не имеет вовсе.
 *
 * Второе: **единица та же, что у числа рядом**. В строке агента стоит его
 * расход — сумма всех четырёх видов токенов, — и темп считается по ней же.
 * Считать темп по «новым» токенам, а расход по всем, значит показать рядом два
 * числа в разных валютах, из которых нельзя вывести третье.
 */
import type { Db, SqlValue } from '../index/db.ts'

export const DEFAULT_RATE_WINDOW_MS = 5 * 60_000
/** Короче этого темп не считается: одна точка — не темп. */
export const RATE_FLOOR_MS = 60_000

/**
 * Расход живых сессий за хвостовое окно, свёрнутый по сабагентам.
 *
 * Свёртка по `parent_session_id` — та же, что в расходе сессии: у сабагента нет
 * своего процесса и своей строки в трее, а токены он тратит родительские.
 */
export function windowTokens(
  db: Db,
  ids: readonly string[],
  from: number,
  to: number,
): Map<string, number> {
  const out = new Map<string, number>()
  if (ids.length === 0 || to <= from) return out
  const rows = db.all<{ key: string; tokens: number }>(
    `SELECT coalesce(sessions.parent_session_id, sessions.id) AS key,
            sum(requests.input + requests.output + requests.cache_write + requests.cache_read) AS tokens
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE requests.ts >= ? AND requests.ts < ?
       AND coalesce(sessions.parent_session_id, sessions.id) IN (${ids.map(() => '?').join(', ')})
     GROUP BY key`,
    from as SqlValue,
    to as SqlValue,
    ...(ids as SqlValue[]),
  )
  for (const row of rows) out.set(row.key, row.tokens)
  return out
}

/** Расход одной сессии с начала её текущего хода (6.1). */
export interface TurnSpend {
  tokens: number
  requests: number
  /** Сколько запросов восстановлено арифметикой (1.3) — для знака `≈`. */
  reconstructed: number
}

/**
 * Расход с начала текущего хода — у каждой сессии свой отсчёт.
 *
 * Отдельно от `windowTokens` потому, что там окно общее и скользящее (темп за
 * последние пять минут), а здесь граница у каждой сессии своя и стоит на месте:
 * это момент, когда человек передал слово. Свернуть их в одну функцию значило
 * бы завести необязательный параметр, меняющий смысл ответа.
 *
 * Свёртка по `parent_session_id` — та же, что у расхода сессии: сабагент тратит
 * токены родителя, и ход, в котором его позвали, — родительский.
 */
export function turnTokens(
  db: Db,
  starts: ReadonlyMap<string, number>,
  at: number,
): Map<string, TurnSpend> {
  const out = new Map<string, TurnSpend>()
  if (starts.size === 0) return out
  const pairs = [...starts.entries()].filter(([, from]) => from <= at)
  if (pairs.length === 0) return out
  const key = 'coalesce(sessions.parent_session_id, sessions.id)'
  const rows = db.all<{
    key: string
    tokens: number
    requests: number
    reconstructed: number
  }>(
    `SELECT ${key} AS key,
            sum(requests.input + requests.output + requests.cache_write + requests.cache_read) AS tokens,
            count(*) AS requests,
            coalesce(sum(requests.origin != 'log'), 0) AS reconstructed
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${pairs.map(() => `(${key} = ? AND requests.ts >= ?)`).join(' OR ')}
     GROUP BY key`,
    ...(pairs.flat() as SqlValue[]),
  )
  for (const row of rows) {
    out.set(row.key, {
      tokens: row.tokens,
      requests: row.requests,
      reconstructed: row.reconstructed,
    })
  }
  return out
}

/**
 * Токенов в минуту. `spanMs` — сколько времени реально накрыто наблюдением:
 * возраст сессии, обрезанный окном усреднения.
 */
export function perMinute(tokens: number, spanMs: number, floorMs = RATE_FLOOR_MS): number {
  if (spanMs < floorMs || tokens <= 0) return 0
  return Math.round((tokens * 60_000) / spanMs)
}

/**
 * Сколько минут наблюдения стоит за темпом: возраст, обрезанный сверху окном
 * усреднения. Отдельной функцией, потому что то же деление нужно и прогнозу
 * лимита, где возраст считается от начала окна, а не от старта сессии.
 */
export function observedSpan(at: number, since: number, windowMs: number): number {
  return Math.min(windowMs, Math.max(0, at - since))
}
