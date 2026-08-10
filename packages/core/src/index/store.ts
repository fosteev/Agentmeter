import type { Db } from './db.ts'
import type { SourceFile } from './discover.ts'
import type { ParseDiagnostics, ParseResult, Request, Session, ToolCall } from '../sources/types.ts'
import { putLimitObservations } from './limits.ts'

export interface SourceStat {
  inode: number
  size: number
  mtime: number
}

export function putSource(db: Db, file: SourceFile, stat: SourceStat): void {
  db.run(
    `INSERT INTO sources (path, provider, inode, size, mtime, offset, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       provider = excluded.provider,
       inode = excluded.inode,
       size = excluded.size,
       mtime = excluded.mtime,
       offset = excluded.offset,
       parsed_at = excluded.parsed_at`,
    file.path,
    file.provider,
    stat.inode,
    stat.size,
    stat.mtime,
    stat.size,
    Date.now(),
  )
}

/**
 * Строка источника пишется здесь же, одной транзакцией с данными сессии.
 * Порознь между ними остаётся щель: `sources` уже говорит «файл разобран до
 * такого-то размера», а `sessions` пуст — и до следующего изменения файла его
 * расход не увидит никто. Тихая недостача ровно того сорта, ради борьбы с
 * которым затевался продукт.
 */
export function putSession(db: Db, result: ParseResult, file: SourceFile, stat?: SourceStat): void {
  db.transaction(() => {
    db.run('DELETE FROM sessions WHERE source_path = ?', file.path)
    db.run('DELETE FROM diagnostics WHERE source_path = ?', file.path)
    db.run('DELETE FROM limit_observations WHERE source_path = ?', file.path)
    insertSession(db, result.session)
    for (const request of result.requests) insertRequest(db, request)
    insertDiagnostics(db, file.path, result.diagnostics, result.session.cliVersion)
    putLimitObservations(db, file.path, result.session.provider, result.limits ?? [])
    if (stat) putSource(db, file, stat)
    db.run('UPDATE sources SET session_id = ? WHERE path = ?', result.session.id, file.path)
  })
}

export function forgetSource(db: Db, path: string): void {
  db.transaction(() => {
    db.run('DELETE FROM sessions WHERE source_path = ?', path)
    db.run('DELETE FROM diagnostics WHERE source_path = ?', path)
    db.run('DELETE FROM limit_observations WHERE source_path = ?', path)
    db.run('DELETE FROM sources WHERE path = ?', path)
  })
}

export function putFailure(db: Db, file: SourceFile, detail: string): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO diagnostics (source_path, kind, detail, count, cli_version, seen_at)
       VALUES (?, 'parser_error', ?, 1, NULL, ?)
       ON CONFLICT(source_path, kind, detail) DO UPDATE SET
         count = diagnostics.count + 1,
         seen_at = excluded.seen_at`,
      file.path,
      detail,
      Date.now(),
    )
  })
}

function insertSession(db: Db, session: Session): void {
  db.run(
    `INSERT INTO sessions (
       id, provider, source_path, cwd, project, branch, model, entrypoint, cli_version,
       title, first_prompt, started_at, ended_at, parent_session_id, parent_tool_use_id,
       agent_type, is_sidechain
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session.id,
    session.provider,
    session.sourcePath,
    session.cwd,
    session.project,
    session.branch ?? null,
    session.model ?? null,
    session.entrypoint ?? null,
    session.cliVersion ?? null,
    session.title ?? null,
    session.firstPrompt ?? null,
    session.startedAt,
    session.endedAt,
    session.parentSessionId ?? null,
    session.parentToolUseId ?? null,
    session.agentType ?? null,
    session.isSidechain ? 1 : 0,
  )
}

function insertRequest(db: Db, request: Request): void {
  db.run(
    `INSERT INTO requests (
       session_id, seq, request_id, ts, model, input, output, cache_write, cache_read,
       reasoning, cache_write_5m, cache_write_1h, context_tokens, context_window,
       skill, is_sidechain, compacted, synthetic, interjected_bytes, origin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    request.sessionId,
    request.seq,
    request.requestId,
    request.ts,
    request.model,
    request.input,
    request.output,
    request.cacheWrite,
    request.cacheRead,
    request.reasoning ?? null,
    request.cacheWrite5m ?? null,
    request.cacheWrite1h ?? null,
    request.contextTokens,
    request.contextWindow ?? null,
    request.skill ?? null,
    request.isSidechain ? 1 : 0,
    request.compacted ? 1 : 0,
    request.synthetic ? 1 : 0,
    request.interjectedBytes,
    request.origin,
  )

  for (let index = 0; index < request.tools.length; index += 1) {
    const tool = request.tools[index]
    if (tool === undefined) continue
    insertToolCall(db, request, tool, index)
  }
}

function insertToolCall(db: Db, request: Request, tool: ToolCall, index: number): void {
  db.run(
    `INSERT INTO tool_calls (
       session_id, seq, idx, tool_use_id, name, kind, server, result_bytes, marginal_tokens,
       marginal_basis, has_image
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    request.sessionId,
    request.seq,
    index,
    tool.id,
    tool.name,
    tool.kind,
    tool.server ?? null,
    tool.resultBytes,
    tool.marginalTokens,
    tool.marginalBasis,
    tool.hasImage ? 1 : 0,
  )

  // `OR IGNORE`, а не `OR REPLACE`: тот же путь в том же вызове — это один
  // затронутый файл, и второе действие над ним ничего не добавляет. Замена
  // молча переписала бы `action`, то есть чтение превратилось бы в правку или
  // наоборот в зависимости от порядка строк патча.
  for (const file of tool.files ?? []) {
    db.run(
      `INSERT OR IGNORE INTO tool_files (session_id, seq, idx, path, action)
       VALUES (?, ?, ?, ?, ?)`,
      request.sessionId,
      request.seq,
      index,
      file.path,
      file.action,
    )
  }
}

function insertDiagnostics(
  db: Db,
  sourcePath: string,
  diagnostics: ParseDiagnostics,
  cliVersion: string | undefined,
): void {
  const seenAt = Date.now()
  for (const [type, count] of Object.entries(diagnostics.unknownRecordTypes)) {
    db.run(
      `INSERT INTO diagnostics (source_path, kind, detail, count, cli_version, seen_at)
       VALUES (?, 'unknown_record_type', ?, ?, ?, ?)`,
      sourcePath,
      type,
      count,
      cliVersion ?? null,
      seenAt,
    )
  }
  if (diagnostics.malformedLines > 0) {
    db.run(
      `INSERT INTO diagnostics (source_path, kind, detail, count, cli_version, seen_at)
       VALUES (?, 'malformed_lines', 'json', ?, ?, ?)`,
      sourcePath,
      diagnostics.malformedLines,
      cliVersion ?? null,
      seenAt,
    )
  }
}
