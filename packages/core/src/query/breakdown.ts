import type { Db, SqlValue } from '../index/db.ts'
import type { MarginalBasis } from '../sources/types.ts'
import { taskFilter, taskSessions } from './task.ts'
import { emptyTotals, sourceCount, totalsFromRow } from './today.ts'
import type {
  BreakdownReport,
  DayRange,
  TokenBreakdownRow,
  ToolBreakdownRow,
  TotalsRow,
} from './types.ts'

/**
 * Разложить можно период либо задачу. Задача — это дерево сессий: сабагенты
 * сводятся в корень так же, как в `taskRows`, иначе ось `agent` на одной сессии
 * всегда возвращала бы один `main`, а карточка недосчитывала бы вызовов, о
 * которых шапка над ней уже отчиталась.
 *
 * `range` у задачи необязателен и означает то же, что у ленты: показать кусок
 * задачи, попавший в период. Без него — вся задача целиком.
 */
type Scope = { range: DayRange } | { sessionId: string; range?: DayRange }

interface TotalRow {
  input: number
  output: number
  cache_write: number
  cache_read: number
  requests: number
}

interface NamedTotalRow extends TotalRow {
  key: string
}

interface TokenRow {
  key: string
  basis?: MarginalBasis
  calls: number
  tokens: number
}

export function breakdownReport(db: Db, scope: Scope): BreakdownReport {
  const filter = scopeFilter(db, scope)
  const totalRow = db.get<TotalRow>(
    `SELECT coalesce(sum(requests.input), 0) AS input,
            coalesce(sum(requests.output), 0) AS output,
            coalesce(sum(requests.cache_write), 0) AS cache_write,
            coalesce(sum(requests.cache_read), 0) AS cache_read,
            count(*) AS requests
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}`,
    ...filter.params,
  )
  const totals = totalRow ? totalsFromRow(totalRow) : emptyTotals()
  const emptyIndex = sourceCount(db) === 0
  const emptyScope = totals.requests === 0
  return {
    emptyIndex,
    emptyScope,
    totals: emptyIndex || emptyScope ? null : totals,
    tool: toolRows(db, filter),
    server: tokenRows(db, filter, 'tool_calls.server', 'tool_calls.server IS NOT NULL'),
    skill: totalRows(db, filter, 'requests.skill', 'requests.skill IS NOT NULL'),
    agent: totalRows(db, filter, "coalesce(sessions.agent_type, 'main')"),
    model: totalRows(db, filter, 'requests.model'),
  }
}

function toolRows(db: Db, filter: { sql: string; params: SqlValue[] }): ToolBreakdownRow[] {
  const rows = db.all<TokenRow>(
    `SELECT tool_calls.name AS key, tool_calls.marginal_basis AS basis,
            count(*) AS calls, sum(tool_calls.marginal_tokens) AS tokens
     FROM tool_calls
     JOIN requests ON requests.session_id = tool_calls.session_id AND requests.seq = tool_calls.seq
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}
     GROUP BY tool_calls.name, tool_calls.marginal_basis`,
    ...filter.params,
  )
  const grouped = new Map<string, ToolBreakdownRow>()
  for (const row of rows) {
    const value =
      grouped.get(row.key) ??
      ({
        key: row.key,
        calls: { measured: 0, split: 0, unknown: 0 },
        tokens: { measured: 0, split: 0, unknown: 0 },
      } satisfies ToolBreakdownRow)
    value.calls[row.basis!] += row.calls
    value.tokens[row.basis!] += row.tokens
    grouped.set(row.key, value)
  }
  return [...grouped.values()].sort(
    (left, right) =>
      tokenSum(right.tokens) - tokenSum(left.tokens) || left.key.localeCompare(right.key),
  )
}

function tokenRows(
  db: Db,
  filter: { sql: string; params: SqlValue[] },
  expression: string,
  extra: string,
): TokenBreakdownRow[] {
  return db.all<TokenBreakdownRow>(
    `SELECT ${expression} AS key, count(*) AS calls,
            sum(tool_calls.marginal_tokens) AS tokens
     FROM tool_calls
     JOIN requests ON requests.session_id = tool_calls.session_id AND requests.seq = tool_calls.seq
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql} AND ${extra}
     GROUP BY ${expression}
     ORDER BY tokens DESC, key`,
    ...filter.params,
  )
}

function totalRows(
  db: Db,
  filter: { sql: string; params: SqlValue[] },
  expression: string,
  extra?: string,
): TotalsRow[] {
  return db
    .all<NamedTotalRow>(
      `SELECT ${expression} AS key, sum(requests.input) AS input,
              sum(requests.output) AS output, sum(requests.cache_write) AS cache_write,
              sum(requests.cache_read) AS cache_read, count(*) AS requests
       FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE ${filter.sql}${extra ? ` AND ${extra}` : ''}
       GROUP BY ${expression}
       ORDER BY sum(requests.input + requests.output + requests.cache_write + requests.cache_read) DESC,
                key`,
      ...filter.params,
    )
    .map((row) => ({ key: row.key, totals: totalsFromRow(row) }))
}

function scopeFilter(db: Db, scope: Scope): { sql: string; params: SqlValue[] } {
  if (!('sessionId' in scope)) {
    return {
      sql: 'requests.ts >= ? AND requests.ts < ?',
      params: [scope.range.from, scope.range.to],
    }
  }
  return taskFilter(taskSessions(db, scope.sessionId), scope.range)
}

function tokenSum(values: Record<MarginalBasis, number>): number {
  return values.measured + values.split + values.unknown
}
