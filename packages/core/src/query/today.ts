import type { Db, SqlValue } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { taskRows } from './tasks.ts'
import type { DayRange, TodayReport, Totals, TotalsRow } from './types.ts'

interface AggregateRow {
  key: string
  input: number
  output: number
  cache_write: number
  cache_read: number
  requests: number
}

interface SummaryRow extends Omit<AggregateRow, 'key'> {
  sessions: number
  reconstructed: number
}

export function todayReport(db: Db, range: DayRange, provider?: Provider): TodayReport {
  const filter = requestFilter(range, provider)
  const summary = db.get<SummaryRow>(
    `SELECT coalesce(sum(requests.input), 0) AS input,
            coalesce(sum(requests.output), 0) AS output,
            coalesce(sum(requests.cache_write), 0) AS cache_write,
            coalesce(sum(requests.cache_read), 0) AS cache_read,
            count(*) AS requests,
            count(DISTINCT requests.session_id) AS sessions,
            coalesce(sum(requests.origin != 'log'), 0) AS reconstructed
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}`,
    ...filter.params,
  )!
  const totals = totalsFromRow(summary)
  const taskCount = taskRows(db, range, provider).length
  const emptyIndex = sourceCount(db) === 0
  const emptyDay = totals.requests === 0

  return {
    range,
    emptyIndex,
    emptyDay,
    approximate: summary.reconstructed > 0,
    totals: emptyIndex || emptyDay ? null : totals,
    tasks: emptyIndex || emptyDay ? null : taskCount,
    sessions: emptyIndex || emptyDay ? null : summary.sessions,
    providers: aggregate(db, filter, 'sessions.provider'),
    models: aggregate(db, filter, 'requests.model'),
    projects: aggregate(db, filter, 'sessions.project'),
    hours: aggregateHours(db, filter),
  }
}

function aggregate(
  db: Db,
  filter: { sql: string; params: SqlValue[] },
  expression: string,
): TotalsRow[] {
  return db
    .all<AggregateRow>(
      `SELECT ${expression} AS key,
              sum(requests.input) AS input, sum(requests.output) AS output,
              sum(requests.cache_write) AS cache_write,
              sum(requests.cache_read) AS cache_read, count(*) AS requests
       FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE ${filter.sql}
       GROUP BY ${expression}
       ORDER BY sum(requests.input + requests.output + requests.cache_write + requests.cache_read) DESC,
                key`,
      ...filter.params,
    )
    .map((row) => ({ key: row.key, totals: totalsFromRow(row) }))
}

function aggregateHours(
  db: Db,
  filter: { sql: string; params: SqlValue[] },
): Array<TotalsRow & { hour: number }> {
  const rows = db.all<AggregateRow & { ts: number }>(
    `SELECT requests.ts, requests.input, requests.output, requests.cache_write,
            requests.cache_read, 1 AS requests, '' AS key
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}`,
    ...filter.params,
  )
  const hours = new Map<number, Totals>()
  for (const row of rows) {
    const hour = new Date(row.ts).getHours()
    const totals = hours.get(hour) ?? emptyTotals()
    addTotals(totals, totalsFromRow(row))
    hours.set(hour, totals)
  }
  return [...hours.entries()]
    .sort(([left], [right]) => left - right)
    .map(([hour, totals]) => ({ key: String(hour), hour, totals }))
}

function requestFilter(
  range: DayRange,
  provider: Provider | undefined,
): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [range.from, range.to]
  let sql = 'requests.ts >= ? AND requests.ts < ?'
  if (provider !== undefined) {
    sql += ' AND sessions.provider = ?'
    params.push(provider)
  }
  return { sql, params }
}

export function totalsFromRow(row: Omit<AggregateRow, 'key'>): Totals {
  return {
    input: row.input,
    output: row.output,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
    total: row.input + row.output + row.cache_write + row.cache_read,
    requests: row.requests,
  }
}

export function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0 }
}

export function addTotals(target: Totals, value: Totals): void {
  target.input += value.input
  target.output += value.output
  target.cacheWrite += value.cacheWrite
  target.cacheRead += value.cacheRead
  target.total += value.total
  target.requests += value.requests
}

export function sourceCount(db: Db): number {
  return db.get<{ count: number }>('SELECT count(*) AS count FROM sources')?.count ?? 0
}
