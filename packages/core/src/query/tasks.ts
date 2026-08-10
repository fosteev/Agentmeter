import type { Db } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { addTotals, emptyTotals, requestFilter } from './today.ts'
import type { DayRange, RequestScope, TaskRow } from './types.ts'

interface RequestRow {
  session_id: string
  provider: Provider
  started_at: number
  ended_at: number
  project: string
  branch: string | null
  session_model: string | null
  title: string | null
  first_prompt: string | null
  parent_session_id: string | null
  is_sidechain: number
  model: string
  input: number
  output: number
  cache_write: number
  cache_read: number
  origin: string
  tool_calls: number
}

export function taskRows(db: Db, range: DayRange, scope: RequestScope = {}): TaskRow[] {
  const filter = requestFilter(range, scope)
  const requests = db.all<RequestRow>(
    `SELECT requests.session_id, sessions.provider, sessions.started_at, sessions.ended_at,
            sessions.project, sessions.branch, sessions.model AS session_model,
            sessions.title, sessions.first_prompt, sessions.parent_session_id,
            sessions.is_sidechain, requests.model, requests.input, requests.output,
            requests.cache_write, requests.cache_read, requests.origin,
            (SELECT count(*) FROM tool_calls
             WHERE tool_calls.session_id = requests.session_id
               AND tool_calls.seq = requests.seq) AS tool_calls
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}
     ORDER BY sessions.started_at, requests.seq`,
    ...filter.params,
  )
  const bySession = new Map<string, TaskRow & { parentSessionId: string | null }>()

  for (const request of requests) {
    let row = bySession.get(request.session_id)
    if (!row) {
      row = {
        sessionId: request.session_id,
        provider: request.provider,
        startedAt: request.started_at,
        endedAt: request.ended_at,
        durationMs: Math.max(0, request.ended_at - request.started_at),
        project: request.project,
        branch: request.branch,
        model: request.session_model ?? request.model,
        title: request.title,
        firstPrompt: request.first_prompt,
        totals: emptyTotals(),
        toolCalls: 0,
        subagents: 0,
        approximate: false,
        sidechain: request.is_sidechain === 1,
        parentSessionId: request.parent_session_id,
      }
      bySession.set(request.session_id, row)
    }
    const total = request.input + request.output + request.cache_write + request.cache_read
    addTotals(row.totals, {
      input: request.input,
      output: request.output,
      cacheWrite: request.cache_write,
      cacheRead: request.cache_read,
      total,
      requests: 1,
    })
    row.toolCalls += request.tool_calls
    row.approximate ||= request.origin !== 'log'
  }

  const roots = new Map<string, TaskRow>()
  for (const row of bySession.values()) {
    const rootId = findRoot(row.sessionId, bySession)
    const source = bySession.get(rootId)!
    if (!roots.has(rootId)) {
      roots.set(rootId, {
        ...publicRow(source),
        totals: emptyTotals(),
        toolCalls: 0,
        subagents: 0,
      })
    }
    const root = roots.get(rootId)!
    addTotals(root.totals, row.totals)
    root.toolCalls += row.toolCalls
    if (row.sessionId !== rootId) root.subagents += 1
    root.startedAt = Math.min(root.startedAt, row.startedAt)
    root.endedAt = Math.max(root.endedAt, row.endedAt)
    root.durationMs = Math.max(0, root.endedAt - root.startedAt)
    root.approximate ||= row.approximate
  }

  return [...roots.values()].sort(
    (left, right) =>
      right.startedAt - left.startedAt || left.sessionId.localeCompare(right.sessionId),
  )
}

function publicRow(row: TaskRow & { parentSessionId: string | null }): TaskRow {
  return {
    sessionId: row.sessionId,
    provider: row.provider,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    project: row.project,
    branch: row.branch,
    model: row.model,
    title: row.title,
    firstPrompt: row.firstPrompt,
    totals: row.totals,
    toolCalls: row.toolCalls,
    subagents: row.subagents,
    approximate: row.approximate,
    sidechain: row.sidechain,
  }
}

function findRoot(
  sessionId: string,
  rows: ReadonlyMap<string, TaskRow & { parentSessionId: string | null }>,
): string {
  const seen = new Set<string>()
  let current = sessionId
  while (!seen.has(current)) {
    seen.add(current)
    const parent = rows.get(current)?.parentSessionId
    if (!parent || !rows.has(parent)) return current
    current = parent
  }
  // Цикл в связях не должен съедать расход: оставляем исходную сессию корнем.
  return sessionId
}
