import { statSync, type Stats } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { discoverSources, type DiscoverOpts, type SourceFile } from './discover.ts'
import { putFailure, putSession, forgetSource } from './store.ts'
import type { Db } from './db.ts'
import { parseSubagentFile } from '../sources/claude/parse.ts'
import { parseSessionFile } from '../sources/claude/index.ts'
import { parseRolloutFile } from '../sources/codex/index.ts'
import type { ParseResult } from '../sources/types.ts'

export type { DiscoverOpts } from './discover.ts'

export interface IngestStats {
  scanned: number
  parsed: number
  skipped: number
  removed: number
  failed: number
  sessions: number
  requests: number
  ms: number
}

interface SourceRow {
  inode: number
  size: number
  mtime: number
  offset: number
}

interface FileIngestResult {
  parsed: boolean
  requests: number
  failed: boolean
}

export function ingestAll(db: Db, opts: DiscoverOpts = {}): IngestStats {
  const started = performance.now()
  const files = discoverSources(opts)
  const seen = new Set(files.map((file) => file.path))
  let parsed = 0
  let skipped = 0
  let failed = 0

  for (const file of files) {
    const result = ingestOne(db, file)
    if (result.failed) failed += 1
    else if (result.parsed) parsed += 1
    else skipped += 1
  }

  let removed = 0
  for (const row of db.all<{ path: string }>('SELECT path FROM sources')) {
    if (seen.has(row.path)) continue
    forgetSource(db, row.path)
    removed += 1
  }

  return {
    scanned: files.length,
    parsed,
    skipped,
    removed,
    failed,
    sessions: db.get<{ count: number }>('SELECT count(*) AS count FROM sessions')?.count ?? 0,
    requests: db.get<{ count: number }>('SELECT count(*) AS count FROM requests')?.count ?? 0,
    ms: Math.round(performance.now() - started),
  }
}

export function ingestFile(db: Db, file: SourceFile): { parsed: boolean; requests: number } {
  const result = ingestOne(db, file)
  return { parsed: result.parsed, requests: result.requests }
}

function ingestOne(db: Db, file: SourceFile): FileIngestResult {
  // Не `existsSync` + `statSync`: между ними файл успевает исчезнуть, и это не
  // теория — Claude Code сам подчищает старые транскрипты по `cleanupPeriodDays`
  // прямо во время прохода. Уронить весь `ingestAll` из-за одного удалённого
  // файла нельзя.
  const stat = statFile(file.path)
  if (!stat) {
    forgetSource(db, file.path)
    return { parsed: false, requests: 0, failed: false }
  }

  const current = { inode: stat.ino, size: stat.size, mtime: Math.round(stat.mtimeMs) }
  const row = db.get<SourceRow>(
    'SELECT inode, size, mtime, offset FROM sources WHERE path = ?',
    file.path,
  )
  if (
    row &&
    row.inode === current.inode &&
    row.size === current.size &&
    row.mtime === current.mtime &&
    row.offset === current.size
  ) {
    return { parsed: false, requests: 0, failed: false }
  }

  try {
    const result = parseFile(file)
    putSession(db, result, file, current)
    return { parsed: true, requests: result.requests.length, failed: false }
  } catch (error) {
    forgetSource(db, file.path)
    putFailure(db, file, error instanceof Error ? error.message : String(error))
    return { parsed: false, requests: 0, failed: true }
  }
}

function parseFile(file: SourceFile): ParseResult {
  if (file.provider === 'codex') return parseRolloutFile(file.path)
  if (file.kind === 'subagent') return parseSubagentFile(file.path, parentId(file))
  return parseSessionFile(file.path)
}

function statFile(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

function parentId(file: SourceFile): string {
  if (!file.parentPath) return ''
  const name = file.parentPath.split(/[\\/]/).at(-1) ?? ''
  return name.replace(/\.jsonl$/, '')
}
