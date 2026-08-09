/**
 * Проверка индекса на живых логах.
 *
 *     node --experimental-strip-types scripts/probe/index-live.ts
 *
 * Живые `~/.claude/projects` и `~/.codex/sessions` только читаются. Все
 * операции с обрезкой и ротацией идут на копиях во временном каталоге.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  defaultIndexPath,
  discoverSources,
  ingestAll,
  ingestFile,
} from '../../packages/core/src/index.ts'
import { openDb, type Db } from '../../packages/core/src/index/db.ts'
import type { SourceFile } from '../../packages/core/src/index/discover.ts'
import { parseSubagentFile } from '../../packages/core/src/sources/claude/parse.ts'
import { parseSessionFile } from '../../packages/core/src/sources/claude/index.ts'
import { parseRolloutFile } from '../../packages/core/src/sources/codex/index.ts'
import type { ParseResult, Request } from '../../packages/core/src/index.ts'

interface Totals {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  marginal: number
}

interface Rows {
  sessions: number
  requests: number
  tools: number
}

let failed = false
const tmp = mkdtempSync(join(tmpdir(), 'agentmeter-index-live-'))
process.env['AGENTMETER_INDEX'] = join(tmp, 'index.sqlite')

const { db } = openDb(defaultIndexPath())

try {
  const cold = ingestAll(db)
  console.log(
    `cold: ms=${cold.ms} files=${cold.scanned} sessions=${cold.sessions} requests=${cold.requests} failed=${cold.failed}`,
  )
  check(cold.ms < 60_000 && cold.failed === 0 && cold.scanned > 0, 'cold pass failed')

  const files = discoverSources()
  const equality = checkIndexEqualsParser(db, files)
  console.log(`equal-parser: checked=${equality.checked} mismatches=${equality.mismatches}`)
  check(equality.mismatches === 0 && equality.checked === files.length, 'index differs from parser')

  const beforeRepeat = rows(db)
  const repeat = ingestAll(db)
  const afterRepeat = rows(db)
  const rowDelta =
    Math.abs(afterRepeat.sessions - beforeRepeat.sessions) +
    Math.abs(afterRepeat.requests - beforeRepeat.requests) +
    Math.abs(afterRepeat.tools - beforeRepeat.tools)
  console.log(`repeat: parsed=${repeat.parsed} skipped=${repeat.skipped} rowDelta=${rowDelta}`)
  check(
    repeat.parsed === 0 && repeat.skipped === repeat.scanned && rowDelta === 0,
    'repeat ingest reparsed files',
  )

  const pathologicalSource = largestCodexRollout(files)
  const candidates = files
    .filter(
      (file) =>
        file.kind === 'session' &&
        file.path !== pathologicalSource.path &&
        requestCount(parseFile(file)) > 0,
    )
    .sort((a, b) => statSync(b.path).size - statSync(a.path).size)
  const primary = candidates[0]
  const rotated = candidates.find(
    (file) => file.provider === primary?.provider && file.path !== primary.path,
  )
  if (!primary || !rotated)
    throw new Error('not enough live session files for append/truncate/rotation probe')

  const append = probeAppend(db, primary)
  console.log(`append: ms=${append.ms} requests=${append.requests} mismatches=${append.mismatches}`)
  check(append.ms < 100 && append.mismatches === 0, 'append probe failed')

  const truncate = probeTruncate(db, primary)
  console.log(
    `truncate: parsed=${truncate.parsed ? 1 : 0} requests=${truncate.requests} mismatches=${truncate.mismatches}`,
  )
  check(truncate.parsed && truncate.mismatches === 0, 'truncate probe failed')

  const rotate = probeRotate(db, primary, rotated)
  console.log(
    `rotate: parsed=${rotate.parsed ? 1 : 0} staleSessions=${rotate.staleSessions} mismatches=${rotate.mismatches}`,
  )
  check(
    rotate.parsed && rotate.staleSessions === 0 && rotate.mismatches === 0,
    'rotation probe failed',
  )

  const pathological = probePathologicalRollout(pathologicalSource)
  console.log(
    `pathological-rollout: ms=${pathological.ms} mb=${pathological.mb.toFixed(1)} file=${basename(pathological.path)}`,
  )
  check(pathological.ms < 300, 'pathological rollout too slow')
} finally {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
}

if (failed) process.exit(1)

function check(ok: boolean, message: string): void {
  if (ok) return
  failed = true
  console.error(`FAIL: ${message}`)
}

function checkIndexEqualsParser(
  db: Db,
  files: SourceFile[],
): { checked: number; mismatches: number } {
  let mismatches = 0
  for (const file of files) {
    const parsed = sumRequests(parseFile(file).requests)
    const indexed = indexedTotals(db, file.path)
    if (!sameTotals(parsed, indexed)) {
      mismatches += 1
      console.error(
        `mismatch: ${file.path} parser=${JSON.stringify(parsed)} index=${JSON.stringify(indexed)}`,
      )
    }
  }
  return { checked: files.length, mismatches }
}

function probeAppend(
  _db: Db,
  source: SourceFile,
): { ms: number; requests: number; mismatches: number } {
  const db = openDb(join(tmp, 'append.sqlite')).db
  const path = join(tmp, `append-${basename(source.path)}`)
  try {
    const full = readFileSync(source.path)
    writeFileSync(path, full.subarray(0, Math.floor(full.length * 0.8)))
    const file = cloneSource(source, path)
    ingestFile(db, file)

    writeFileSync(path, full)
    const started = performance.now()
    const result = ingestFile(db, file)
    const ms = Math.round(performance.now() - started)
    return {
      ms,
      requests: result.requests,
      mismatches: sameTotals(indexedTotals(db, path), sumRequests(parseFile(file).requests))
        ? 0
        : 1,
    }
  } finally {
    db.close()
  }
}

function probeTruncate(
  _db: Db,
  source: SourceFile,
): { parsed: boolean; requests: number; mismatches: number } {
  const db = openDb(join(tmp, 'truncate.sqlite')).db
  const path = join(tmp, `truncate-${basename(source.path)}`)
  try {
    const full = readFileSync(source.path)
    writeFileSync(path, full)
    const file = cloneSource(source, path)
    ingestFile(db, file)

    writeFileSync(path, full.subarray(0, Math.floor(full.length * 0.5)))
    const result = ingestFile(db, file)
    return {
      parsed: result.parsed,
      requests: result.requests,
      mismatches: sameTotals(indexedTotals(db, path), sumRequests(parseFile(file).requests))
        ? 0
        : 1,
    }
  } finally {
    db.close()
  }
}

function probeRotate(
  _db: Db,
  source: SourceFile,
  replacement: SourceFile,
): { parsed: boolean; staleSessions: number; mismatches: number } {
  const db = openDb(join(tmp, 'rotate.sqlite')).db
  const path = join(tmp, `rotate-${basename(source.path)}`)
  try {
    copyFileSync(source.path, path)
    const file = cloneSource(source, path)
    ingestFile(db, file)
    const oldSession = db.get<{ id: string }>(
      'SELECT id FROM sessions WHERE source_path = ?',
      path,
    )?.id

    rmSync(path)
    copyFileSync(replacement.path, path)
    const rotated = cloneSource(replacement, path)
    const result = ingestFile(db, rotated)
    const staleSessions = oldSession
      ? db.all('SELECT id FROM sessions WHERE source_path = ? AND id = ?', path, oldSession).length
      : 0
    return {
      parsed: result.parsed,
      staleSessions,
      mismatches: sameTotals(indexedTotals(db, path), sumRequests(parseFile(rotated).requests))
        ? 0
        : 1,
    }
  } finally {
    db.close()
  }
}

function largestCodexRollout(files: SourceFile[]): SourceFile {
  const rollout = files
    .filter((file) => file.provider === 'codex')
    .sort((a, b) => statSync(b.path).size - statSync(a.path).size)[0]
  if (!rollout) throw new Error('codex rollouts not found')
  return rollout
}

function probePathologicalRollout(rollout: SourceFile): { path: string; ms: number; mb: number } {
  const started = performance.now()
  parseRolloutFile(rollout.path)
  return {
    path: rollout.path,
    ms: Math.round(performance.now() - started),
    mb: statSync(rollout.path).size / 1024 / 1024,
  }
}

function parseFile(file: SourceFile): ParseResult {
  if (file.provider === 'codex') return parseRolloutFile(file.path)
  if (file.kind === 'subagent') return parseSubagentFile(file.path, parentId(file))
  return parseSessionFile(file.path)
}

function cloneSource(source: SourceFile, path: string): SourceFile {
  const file: SourceFile = { path, provider: source.provider, kind: source.kind }
  if (source.parentPath !== undefined) file.parentPath = source.parentPath
  return file
}

function parentId(file: SourceFile): string {
  return (
    file.parentPath
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.jsonl$/, '') ?? ''
  )
}

function rows(db: Db): Rows {
  return {
    sessions: db.get<{ count: number }>('SELECT count(*) AS count FROM sessions')?.count ?? 0,
    requests: db.get<{ count: number }>('SELECT count(*) AS count FROM requests')?.count ?? 0,
    tools: db.get<{ count: number }>('SELECT count(*) AS count FROM tool_calls')?.count ?? 0,
  }
}

function indexedTotals(db: Db, sourcePath: string): Totals {
  const row = db.get<{
    input: number | null
    output: number | null
    cacheWrite: number | null
    cacheRead: number | null
  }>(
    `SELECT
       sum(r.input) AS input,
       sum(r.output) AS output,
       sum(r.cache_write) AS cacheWrite,
       sum(r.cache_read) AS cacheRead
     FROM sessions s
     LEFT JOIN requests r ON r.session_id = s.id
     WHERE s.source_path = ?`,
    sourcePath,
  )
  const tools = db.get<{ marginal: number | null }>(
    `SELECT sum(t.marginal_tokens) AS marginal
     FROM sessions s
     LEFT JOIN tool_calls t ON t.session_id = s.id
     WHERE s.source_path = ?`,
    sourcePath,
  )
  return {
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
    cacheRead: row?.cacheRead ?? 0,
    marginal: tools?.marginal ?? 0,
  }
}

function sumRequests(requests: Request[]): Totals {
  return requests.reduce(
    (totals, request) => {
      totals.input += request.input
      totals.output += request.output
      totals.cacheWrite += request.cacheWrite
      totals.cacheRead += request.cacheRead
      totals.marginal += request.tools.reduce((sum, tool) => sum + tool.marginalTokens, 0)
      return totals
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, marginal: 0 },
  )
}

function sameTotals(a: Totals, b: Totals): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheWrite === b.cacheWrite &&
    a.cacheRead === b.cacheRead &&
    a.marginal === b.marginal
  )
}

function requestCount(result: ParseResult): number {
  return result.requests.length
}
