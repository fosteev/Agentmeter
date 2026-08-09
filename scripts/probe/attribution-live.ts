/**
 * Проверка маржинальной атрибуции на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/attribution-live.ts
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  attributeMarginal,
  discoverSources,
  parseRolloutFile,
  parseSessionFile,
} from '../../packages/core/src/index.ts'
import { parseSubagentFile } from '../../packages/core/src/sources/claude/parse.ts'
import type {
  MarginalBasis,
  ParseResult,
  Provider,
  Request,
} from '../../packages/core/src/index.ts'
import type { SourceFile } from '../../packages/core/src/index/discover.ts'

interface ParsedFile {
  file: SourceFile
  result: ParseResult
}

interface Coverage {
  calls: number
  tokens: number
  byBasis: Record<MarginalBasis, { calls: number; tokens: number }>
  interjected: number
}

const files = discoverSources()
const parsed: ParsedFile[] = []
const crashes: string[] = []
const parseStarted = performance.now()

for (const file of files) {
  try {
    parsed.push({ file, result: parseFile(file) })
  } catch (error) {
    crashes.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const parseMs = performance.now() - parseStarted

let failed = crashes.length > 0

const conservation = { claude: 0, codex: 0 }
for (const entry of parsed)
  conservation[entry.file.provider] += conservationFailures(entry.result.requests)
report(
  1,
  'сохранение',
  `claude=${conservation.claude} codex=${conservation.codex} crashes=${crashes.length}`,
  conservation.claude === 0 && conservation.codex === 0 && crashes.length === 0,
)

const coverage = {
  claude: coverageFor(parsed, 'claude'),
  codex: coverageFor(parsed, 'codex'),
}
const coverageOk = (['claude', 'codex'] as const).every((provider) => {
  const value = coverage[provider]
  return (
    percent(value.byBasis.unknown.calls, value.calls) <= 3 &&
    percent(value.interjected, value.calls) <= 2
  )
})
report(
  2,
  'покрытие',
  `${formatCoverage('claude', coverage.claude)}; ${formatCoverage('codex', coverage.codex)}`,
  coverageOk,
)

const originalRatios = codexOriginalTokenRatios(parsed)
const originalMedian = median(originalRatios)
report(
  3,
  'Codex Original token count',
  `n=${originalRatios.length} median=${formatNumber(originalMedian, 2)}`,
  originalRatios.length > 0 && originalMedian >= 0.9 && originalMedian <= 1.15,
)

const codexPairs = codexPairStats(parsed)
report(
  4,
  'пары Codex',
  `calls=${codexPairs.calls} duplicate=${codexPairs.duplicates} unknown=${codexPairs.unknown} (${formatNumber(percent(codexPairs.unknown, codexPairs.calls), 2)}%)`,
  codexPairs.duplicates === 0 && percent(codexPairs.unknown, codexPairs.calls) <= 1,
)

const calibration = {
  claude: calibrationMedian(parsed, 'claude'),
  codex: calibrationMedian(parsed, 'codex'),
}
report(
  5,
  'калибровка байт/токен',
  `claude n=${calibration.claude.count} median=${formatNumber(calibration.claude.median, 2)}; ` +
    `codex n=${calibration.codex.count} median=${formatNumber(calibration.codex.median, 2)}`,
  calibration.claude.count > 0 &&
    calibration.claude.median >= 2 &&
    calibration.claude.median <= 3.5 &&
    calibration.codex.count > 0 &&
    calibration.codex.median >= 3 &&
    calibration.codex.median <= 4.5,
)

const mixedParents = parsed.filter(
  ({ file, result }) =>
    file.provider === 'claude' &&
    file.kind === 'session' &&
    result.requests.some((request) => request.isSidechain) &&
    result.requests.some((request) => !request.isSidechain),
)
report(6, 'цепочка не перемешана', `mixed=${mixedParents.length}`, mixedParents.length === 0)

const attributionStarted = performance.now()
for (const { file, result } of parsed) {
  attributeMarginal(result.requests, file.provider)
}
const attributionMs = performance.now() - attributionStarted
const overhead = percent(attributionMs, parseMs)
report(
  7,
  'скорость',
  `files=${files.length} requests=${parsed.reduce((sum, entry) => sum + entry.result.requests.length, 0)} ` +
    `parse=${Math.round(parseMs)}ms attribution=${Math.round(attributionMs)}ms overhead=${formatNumber(overhead, 2)}%`,
  overhead <= 10,
)

for (const crash of crashes.slice(0, 10)) console.error(`  ${crash}`)
for (const entry of mixedParents.slice(0, 10)) console.error(`  mixed: ${entry.file.path}`)

if (failed) process.exit(1)

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}

function parseFile(file: SourceFile): ParseResult {
  if (file.provider === 'codex') return parseRolloutFile(file.path)
  if (file.kind === 'subagent') return parseSubagentFile(file.path, parentId(file))
  return parseSessionFile(file.path)
}

function parentId(file: SourceFile): string {
  return (
    file.parentPath
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.jsonl$/, '') ?? ''
  )
}

function conservationFailures(requests: Request[]): number {
  let failures = 0
  let nextLogged: Request | undefined
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index]!
    if (
      request.tools.length > 0 &&
      nextLogged !== undefined &&
      !nextLogged.compacted &&
      request.interjectedBytes === 0
    ) {
      const expected = Math.max(
        0,
        nextLogged.contextTokens - request.contextTokens - request.output,
      )
      const actual = request.tools.reduce((sum, tool) => sum + tool.marginalTokens, 0)
      if (actual !== expected || request.tools.some((tool) => tool.marginalBasis === 'unknown')) {
        failures += 1
      }
    }
    if (request.origin === 'log') nextLogged = request
  }
  return failures
}

function coverageFor(entries: ParsedFile[], provider: Provider): Coverage {
  const result: Coverage = {
    calls: 0,
    tokens: 0,
    byBasis: {
      measured: { calls: 0, tokens: 0 },
      split: { calls: 0, tokens: 0 },
      unknown: { calls: 0, tokens: 0 },
    },
    interjected: 0,
  }
  for (const { file, result: parsedResult } of entries) {
    if (file.provider !== provider) continue
    for (const request of parsedResult.requests) {
      for (const tool of request.tools) {
        result.calls += 1
        result.tokens += tool.marginalTokens
        result.byBasis[tool.marginalBasis].calls += 1
        result.byBasis[tool.marginalBasis].tokens += tool.marginalTokens
        if (request.interjectedBytes > 0) result.interjected += 1
      }
    }
  }
  return result
}

function formatCoverage(provider: Provider, coverage: Coverage): string {
  return (
    `${provider} calls=${coverage.calls} ` +
    (['measured', 'split', 'unknown'] as const)
      .map(
        (basis) =>
          `${basis}=${formatNumber(percent(coverage.byBasis[basis].calls, coverage.calls), 1)}%/` +
          `${formatNumber(percent(coverage.byBasis[basis].tokens, coverage.tokens), 1)}%tok`,
      )
      .join(' ') +
    ` interjected=${formatNumber(percent(coverage.interjected, coverage.calls), 2)}%`
  )
}

function codexOriginalTokenRatios(entries: ParsedFile[]): number[] {
  const ratios: number[] = []
  for (const { file, result } of entries) {
    if (file.provider !== 'codex') continue
    const originals = originalTokenCounts(file.path)
    for (const request of result.requests) {
      if (request.tools.length !== 1) continue
      const tool = request.tools[0]!
      const original = originals.get(tool.id)
      if (original === undefined || original <= 2_000 || tool.marginalBasis !== 'measured') continue
      ratios.push(tool.marginalTokens / original)
    }
  }
  return ratios
}

function originalTokenCounts(path: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('Original token count:')) continue
    try {
      const record = JSON.parse(line) as {
        payload?: { type?: string; call_id?: string; output?: unknown }
      }
      const payload = record.payload
      if (
        !payload?.call_id ||
        (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') ||
        typeof payload.output !== 'string'
      ) {
        continue
      }
      const match = /Original token count:\s*(\d+)/.exec(payload.output)
      if (match?.[1]) counts.set(payload.call_id, Number(match[1]))
    } catch {
      // Оборванный хвост живого файла не относится к этой проверке.
    }
  }
  return counts
}

function codexPairStats(entries: ParsedFile[]): {
  calls: number
  duplicates: number
  unknown: number
} {
  let calls = 0
  let duplicates = 0
  let unknown = 0
  for (const { file, result } of entries) {
    if (file.provider !== 'codex') continue
    const seen = new Set<string>()
    for (const tool of result.requests.flatMap((request) => request.tools)) {
      calls += 1
      if (seen.has(tool.id)) duplicates += 1
      else seen.add(tool.id)
      if (tool.name === 'unknown') unknown += 1
    }
  }
  return { calls, duplicates, unknown }
}

function calibrationMedian(
  entries: ParsedFile[],
  provider: Provider,
): { count: number; median: number } {
  const ratios: number[] = []
  for (const { file, result } of entries) {
    if (file.provider !== provider) continue
    for (const request of result.requests) {
      if (request.tools.length !== 1) continue
      const tool = request.tools[0]!
      if (
        tool.hasImage ||
        tool.marginalBasis !== 'measured' ||
        tool.marginalTokens <= 0 ||
        tool.resultBytes <= 0
      ) {
        continue
      }
      ratios.push(tool.resultBytes / tool.marginalTokens)
    }
  }
  return { count: ratios.length, median: median(ratios) }
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}
