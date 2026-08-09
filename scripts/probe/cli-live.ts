/**
 * Проверка query/ и CLI на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/cli-live.ts
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  DEFAULT_CONFIG,
  buildCodexWindows,
  defaultClaudeHome,
  defaultCodexHome,
  dayRange,
  discoverSources,
  ingestAll,
  openDb,
  parseRolloutFile,
  parseSessionFile,
  readLimitWindows,
  readLimits,
  rebuildLimitWindows,
  taskRows,
  todayReport,
  type LimitWindow,
  type ParseResult,
  type Request,
  type SourceFile,
  type Totals,
} from '../../packages/core/src/index.ts'
import { parseSubagentFile } from '../../packages/core/src/sources/claude/parse.ts'
import { run } from '../../apps/cli/src/main.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-cli-live-'))
const indexPath = join(temp, 'index.sqlite')
const snapshotClaude = join(temp, '.claude')
const snapshotCodex = join(temp, '.codex')
const { db } = openDb(indexPath)

try {
  snapshotSources(discoverSources())
  const sourceOptions = { claudeHome: snapshotClaude, codexHome: snapshotCodex }
  const ingest = ingestAll(db, sourceOptions)
  const files = discoverSources(sourceOptions)

  const direct = files.reduce(
    (sum, file) => add(sum, sumRequests(parseFile(file).requests)),
    empty(),
  )
  const indexed = todayReport(db, { from: 0, to: Number.MAX_SAFE_INTEGER }).totals
  const equal = indexed !== null && same(direct, indexed)
  report(
    1,
    'query совпадает с прямым парсером',
    `files=${files.length} requests=${direct.requests} failed=${ingest.failed} mismatches=${equal ? 0 : 1}`,
    files.length > 0 && ingest.failed === 0 && equal,
  )

  let taskMismatches = 0
  let populatedDays = 0
  for (let offset = 0; offset > -7; offset -= 1) {
    const range = dayRange(Date.now(), DEFAULT_CONFIG.ui.dayStartsAtHour, offset)
    const report = todayReport(db, range)
    const tasks = taskRows(db, range)
    const total = tasks.reduce((sum, row) => add(sum, row.totals), empty())
    if (report.totals === null) {
      if (tasks.length !== 0) taskMismatches += 1
    } else {
      populatedDays += 1
      if (!same(total, report.totals)) taskMismatches += 1
    }
  }
  report(
    2,
    'задачи не теряют сабагентов',
    `days=7 populated=${populatedDays} mismatches=${taskMismatches}`,
    populatedDays > 0 && taskMismatches === 0,
  )

  const claudeRequests = db.all<{ ts: number }>(
    `SELECT requests.ts
     FROM requests JOIN sessions ON sessions.id = requests.session_id
     WHERE sessions.provider = 'claude'`,
  )
  const indexedWindows = readLimitWindows(db)
  let coverage = 0
  for (const request of claudeRequests) {
    for (const kind of ['fiveHour', 'weekly'] as const) {
      const count = indexedWindows.filter(
        (window) =>
          window.provider === 'claude' &&
          window.kind === kind &&
          window.startsAt <= request.ts &&
          request.ts < window.resetsAt,
      ).length
      if (count !== 1) coverage += 1
    }
  }
  report(
    3,
    'Claude покрыт окнами ровно один раз',
    `requests=${claudeRequests.length} violations=${coverage}`,
    claudeRequests.length > 0 && coverage === 0,
  )

  let overlaps = 0
  for (const windows of groupWindows(indexedWindows).values()) {
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index]!.startsAt < windows[index - 1]!.resetsAt) overlaps += 1
    }
  }
  report(
    4,
    'окна индекса не пересекаются',
    `windows=${indexedWindows.length} overlaps=${overlaps}`,
    indexedWindows.length > 0 && overlaps === 0,
  )

  const directCodex = buildCodexWindows(
    files
      .filter((file) => file.provider === 'codex' && file.kind === 'session')
      .flatMap((file) => readLimits(file.path)),
  )
  const indexedCodex = indexedWindows.filter((window) => window.provider === 'codex')
  // Сравнивать длины мало: окно с чужим процентом или уехавшим якорем не меняет
  // их числа, а это ровно те две ошибки, ради которых этап и делался.
  const codexDiff = directCodex.filter(
    (window, index) => !sameWindow(window, indexedCodex[index]),
  ).length
  report(
    5,
    'Codex-окна совпадают с прямым readLimits',
    `direct=${directCodex.length} indexed=${indexedCodex.length} mismatches=${codexDiff}`,
    directCodex.length > 0 && directCodex.length === indexedCodex.length && codexDiff === 0,
  )

  rebuildLimitWindows(db, DEFAULT_CONFIG.limits.claude)
  const claudeUnknown = readLimitWindows(db, { provider: 'claude' })
  const numeric = claudeUnknown.filter((window) => window.usedPercent !== null).length
  const json = captureLimitsJson(indexPath, join(temp, 'missing-config.json'))
  const jsonUnknown = json.windows.filter(
    (window) => window.provider === 'claude' && window.usedPercent === null,
  ).length
  const jsonZeros = json.windows.filter(
    (window) => window.provider === 'claude' && window.usedPercent === 0,
  ).length
  report(
    6,
    'неизвестный процент не становится нулём',
    `claudeWindows=${claudeUnknown.length} numeric=${numeric} jsonUnknown=${jsonUnknown} jsonZeros=${jsonZeros}`,
    claudeUnknown.length > 0 && numeric === 0 && jsonUnknown > 0 && jsonZeros === 0,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exit(1)

function parseFile(file: SourceFile): ParseResult {
  if (file.provider === 'codex') return parseRolloutFile(file.path)
  if (file.kind === 'subagent') return parseSubagentFile(file.path, parentId(file))
  return parseSessionFile(file.path)
}

function snapshotSources(files: SourceFile[]): void {
  for (const file of files) {
    const sourceHome = file.provider === 'claude' ? defaultClaudeHome() : defaultCodexHome()
    const targetHome = file.provider === 'claude' ? snapshotClaude : snapshotCodex
    const target = join(targetHome, relative(sourceHome, file.path))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file.path, target)

    if (file.kind !== 'subagent') continue
    const meta = file.path.replace(/\.jsonl$/, '.meta.json')
    if (!existsSync(meta)) continue
    const targetMeta = target.replace(/\.jsonl$/, '.meta.json')
    copyFileSync(meta, targetMeta)
  }
}

function parentId(file: SourceFile): string {
  return (
    file.parentPath
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.jsonl$/, '') ?? ''
  )
}

function sumRequests(requests: readonly Request[]): Totals {
  return requests.reduce(
    (sum, request) =>
      add(sum, {
        input: request.input,
        output: request.output,
        cacheWrite: request.cacheWrite,
        cacheRead: request.cacheRead,
        total: request.input + request.output + request.cacheWrite + request.cacheRead,
        requests: 1,
      }),
    empty(),
  )
}

function empty(): Totals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0 }
}

function add(target: Totals, value: Totals): Totals {
  target.input += value.input
  target.output += value.output
  target.cacheWrite += value.cacheWrite
  target.cacheRead += value.cacheRead
  target.total += value.total
  target.requests += value.requests
  return target
}

function same(left: Totals, right: Totals): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheWrite === right.cacheWrite &&
    left.cacheRead === right.cacheRead &&
    left.total === right.total &&
    left.requests === right.requests
  )
}

function sameWindow(left: LimitWindow, right: LimitWindow | undefined): boolean {
  return (
    right !== undefined &&
    left.kind === right.kind &&
    left.windowMinutes === right.windowMinutes &&
    left.startsAt === right.startsAt &&
    left.resetsAt === right.resetsAt &&
    left.usedPercent === right.usedPercent &&
    left.observedAt === right.observedAt &&
    left.exact === right.exact
  )
}

function groupWindows(windows: LimitWindow[]): Map<string, LimitWindow[]> {
  const groups = new Map<string, LimitWindow[]>()
  for (const window of windows) {
    const key = `${window.provider}:${window.kind}`
    groups.set(key, [...(groups.get(key) ?? []), window])
  }
  for (const group of groups.values()) group.sort((left, right) => left.startsAt - right.startsAt)
  return groups
}

function captureLimitsJson(
  path: string,
  config: string,
): { windows: Array<{ provider: string; usedPercent: number | null }> } {
  let captured = ''
  const original = console.log
  console.log = (value: unknown) => {
    captured = String(value)
  }
  try {
    const code = run(['limits', '--no-ingest', '--index', path, '--config', config, '--json'])
    if (code !== 0) throw new Error(`limits --json завершился с кодом ${code}`)
  } finally {
    console.log = original
  }
  return JSON.parse(captured) as {
    windows: Array<{ provider: string; usedPercent: number | null }>
  }
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
