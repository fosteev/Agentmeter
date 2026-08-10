import { statSync, type Stats } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  discoverSources,
  type DiscoverOpts,
  type SourceFile,
  type SourceIssue,
} from './discover.ts'
import { putFailure, putSession, forgetSource } from './store.ts'
import type { Db } from './db.ts'
import { parseSubagentFile } from '../sources/claude/parse.ts'
import { parseSessionFile } from '../sources/claude/index.ts'
import { parseRolloutFile } from '../sources/codex/index.ts'
import type { ParseResult } from '../sources/types.ts'
import { DEFAULT_CONFIG, type ClaudeLimits } from '../config/types.ts'
import { ensureLimitWindows, rebuildLimitWindows } from './limits.ts'

export type { DiscoverOpts, SourceIssue } from './discover.ts'

export interface IngestStats {
  scanned: number
  parsed: number
  skipped: number
  removed: number
  failed: number
  sessions: number
  requests: number
  ms: number
  /**
   * Источники, до которых не добрались. Пустой список — утверждение
   * «всё прочитано», и попап показывает его как норму; непустой уезжает в
   * экран ошибки (2.8). Раньше такой каталог просто ронял обход целиком.
   */
  issues: SourceIssue[]
}

export interface IngestOptions extends DiscoverOpts {
  claudeLimits?: ClaudeLimits
}

/**
 * Ход первого прохода — вход экрана индексирования (2.8).
 *
 * Байты, а не файлы: транскрипты различаются по размеру на три порядка, и
 * полоса, посчитанная по числу файлов, стоит на месте, а потом прыгает.
 */
export interface IngestProgress {
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
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

export function ingestAll(db: Db, opts: IngestOptions = {}): IngestStats {
  const run = ingestSteps(db, opts)
  let step = run.next()
  while (!step.done) step = run.next()
  return step.value
}

/**
 * Тот же проход, но с остановками.
 *
 * Нужен ровно затем, чтобы окно успевало рисоваться: main — однопоточный, и
 * синхронный проход по девятистам файлам держит и цикл событий, и попап. Код
 * прохода при этом один: разойдись «быстрый» и «с прогрессом», и однажды они
 * разошлись бы в цифрах, а не в скорости.
 *
 * Размеры файлов считаются только когда прогресс кому-то нужен: лишний обход
 * `stat` по всем источникам на каждое событие вотчера не нужен никому.
 */
export function* ingestSteps(
  db: Db,
  opts: IngestOptions & { progress?: boolean } = {},
): Generator<IngestProgress, IngestStats> {
  const started = performance.now()
  const issues: SourceIssue[] = []
  const files = discoverSources({
    ...opts,
    onIssue: (issue) => {
      issues.push(issue)
      opts.onIssue?.(issue)
    },
  })
  const seen = new Set(files.map((file) => file.path))
  let parsed = 0
  let skipped = 0
  let failed = 0

  const sizes = opts.progress === true ? files.map((file) => statFile(file.path)?.size ?? 0) : []
  const bytesTotal = sizes.reduce((sum, size) => sum + size, 0)
  let bytesDone = 0

  for (const [index, file] of files.entries()) {
    const result = ingestOne(db, file)
    if (result.failed) failed += 1
    else if (result.parsed) parsed += 1
    else skipped += 1
    if (opts.progress !== true) continue
    bytesDone += sizes[index] ?? 0
    yield { filesDone: index + 1, filesTotal: files.length, bytesDone, bytesTotal }
  }

  let removed = 0
  for (const row of db.all<{ path: string }>('SELECT path FROM sources')) {
    if (seen.has(row.path)) continue
    forgetSource(db, row.path)
    removed += 1
  }

  // Пересборка — только когда индекс действительно изменился. Вотчер зовёт
  // `ingestAll` на каждое событие файловой системы, включая чужие файлы, и
  // безусловный проход по всем запросам Claude на каждое такое событие — это
  // тот же долг 1.10, только с другой стороны. Смену конфига ловит отпечаток
  // входа внутри `ensureLimitWindows`.
  const limits = opts.claudeLimits ?? DEFAULT_CONFIG.limits.claude
  if (parsed > 0 || removed > 0 || failed > 0) rebuildLimitWindows(db, limits)
  else ensureLimitWindows(db, limits)

  return {
    scanned: files.length,
    parsed,
    skipped,
    removed,
    failed,
    sessions: db.get<{ count: number }>('SELECT count(*) AS count FROM sessions')?.count ?? 0,
    requests: db.get<{ count: number }>('SELECT count(*) AS count FROM requests')?.count ?? 0,
    ms: Math.round(performance.now() - started),
    issues,
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
