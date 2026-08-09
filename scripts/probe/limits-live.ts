/**
 * Проверка модели окон лимита на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/limits-live.ts
 */
import {
  buildClaudeWindows,
  buildCodexWindows,
  discoverSources,
  parseRolloutFile,
  parseSessionFile,
  readLimits,
  type LimitObservation,
  type LimitUsage,
  type LimitWindow,
  type LimitWindowKind,
  type Request,
} from '../../packages/core/src/index.ts'

interface CodexFile {
  version?: string
  observations: LimitObservation[]
}

interface WindowIndex {
  windows: LimitWindow[]
  starts: number[]
  resets: number[]
}

const files = discoverSources()
const codexFiles: CodexFile[] = []
const codexCrashes: string[] = []
let failed = false

for (const file of files) {
  if (file.provider !== 'codex' || file.kind !== 'session') continue
  try {
    codexFiles.push({
      version: parseRolloutFile(file.path).session.cliVersion,
      observations: readLimits(file.path),
    })
  } catch (error) {
    codexCrashes.push(`${file.path}: ${message(error)}`)
  }
}

const observations = codexFiles.flatMap((file) => file.observations)
const codexWindows = buildCodexWindows(observations)
const byMinutes = indexBy(codexWindows, (window) => window.windowMinutes)
const assigned = new Map<LimitWindow, LimitObservation[]>()
let identityViolations = 0

for (const observation of observations) {
  const matches = windowsForObservation(observation, byMinutes.get(observation.windowMinutes))
  const window = matches[0]
  if (
    matches.length !== 1 ||
    !window ||
    window.usedPercent === null ||
    window.usedPercent < observation.usedPercent
  ) {
    identityViolations += 1
    continue
  }
  assigned.set(window, [...(assigned.get(window) ?? []), observation])
}

report(
  1,
  'тождество с логом',
  `observations=${observations.length} windows=${codexWindows.length} violations=${identityViolations} crashes=${codexCrashes.length}`,
  identityViolations === 0 && codexCrashes.length === 0,
)

const fiveHourWindows = codexWindows.filter((window) => window.kind === 'fiveHour')
let anchored = 0
const anchorDistances: number[] = []
for (const window of fiveHourWindows) {
  const first = assigned
    .get(window)
    ?.reduce((minimum, observation) => Math.min(minimum, observation.ts), Number.POSITIVE_INFINITY)
  if (first === undefined || !Number.isFinite(first)) continue
  const distance = Math.abs(window.startsAt - first)
  anchorDistances.push(distance)
  if (distance <= 60_000) anchored += 1
}
const anchorShare = percent(anchored, anchorDistances.length)
report(
  2,
  'якорь',
  `within60s=${anchored}/${anchorDistances.length} (${format(anchorShare, 1)}%) median=${format(median(anchorDistances) / 1000, 1)}s threshold=90%`,
  anchorDistances.length > 0 && anchorShare >= 90,
)

// Проверять «максимум не убывает» бессмысленно — он не убывает по определению.
// Проваливаемая формулировка другая: процент окна обязан равняться максимуму по
// его наблюдениям, а не последнему из них. И проверка имеет смысл только пока в
// живых данных есть сами протухшие снимки — иначе она ничего не стоит.
let rawDrops = 0
let percentMismatches = 0
let staleWindows = 0
for (const [window, windowObservations] of assigned) {
  const sorted = [...windowObservations].sort((left, right) => left.ts - right.ts)
  let maximum = Number.NEGATIVE_INFINITY
  for (const [position, observation] of sorted.entries()) {
    if (position > 0 && observation.usedPercent < sorted[position - 1]!.usedPercent) rawDrops += 1
    maximum = Math.max(maximum, observation.usedPercent)
  }
  if (window.usedPercent !== maximum) percentMismatches += 1
  if (sorted.at(-1)!.usedPercent < maximum) staleWindows += 1
}
report(
  3,
  'процент окна — максимум',
  `mismatches=${percentMismatches} staleWindows=${staleWindows} rawDrops=${rawDrops}`,
  percentMismatches === 0 && staleWindows > 0,
)

let overlaps = 0
for (const windows of groupBy(codexWindows, (window) => window.kind).values()) {
  const sorted = [...windows].sort((left, right) => left.startsAt - right.startsAt)
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.startsAt < sorted[index - 1]!.resetsAt) overlaps += 1
  }
}
report(4, 'цепочка', `overlaps=${overlaps}`, overlaps === 0)

const newLayoutObservations = codexFiles
  .filter((file) => file.version !== undefined && compareSemver(file.version, '0.145.0') >= 0)
  .flatMap((file) => file.observations)
const newLayoutWindows = buildCodexWindows(newLayoutObservations)
const fiveHourAfterChange = newLayoutWindows.filter((window) => window.kind === 'fiveHour').length
const nonWeeklyAfterChange = newLayoutWindows.filter((window) => window.kind !== 'weekly').length
report(
  5,
  'слоты не при чём',
  `observations=${newLayoutObservations.length} windows=${newLayoutWindows.length} fiveHour=${fiveHourAfterChange} nonWeekly=${nonWeeklyAfterChange}`,
  fiveHourAfterChange === 0 && nonWeeklyAfterChange === 0,
)

const claudeRequests: Request[] = []
const claudeCrashes: string[] = []
for (const file of files) {
  if (file.provider !== 'claude' || file.kind !== 'session') continue
  try {
    claudeRequests.push(...parseSessionFile(file.path).requests)
  } catch (error) {
    claudeCrashes.push(`${file.path}: ${message(error)}`)
  }
}

const claudeWindows = buildClaudeWindows(claudeRequests, {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: 0.1,
  plan: null,
})
const claudeByKind = indexBy(claudeWindows, (window) => window.kind)
let coverageViolations = 0
for (const request of claudeRequests) {
  for (const kind of ['fiveHour', 'weekly'] as const) {
    if (containingWindows(request.ts, claudeByKind.get(kind)) !== 1) coverageViolations += 1
  }
}

const requestUsage = sumRequests(claudeRequests)
let usageMismatches = 0
for (const kind of ['fiveHour', 'weekly'] as const) {
  const usage = sumWindowUsage(claudeWindows.filter((window) => window.kind === kind))
  usageMismatches += usageDifferences(usage, requestUsage, 0.1)
}
const unknownWeightWindows = buildClaudeWindows(claudeRequests, {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: null,
  plan: null,
})
const numericUnknownWeights = unknownWeightWindows.filter(
  (window) => typeof window.usage?.weighted === 'number',
).length
report(
  6,
  'Claude: покрытие',
  `requests=${claudeRequests.length} windows=${claudeWindows.length} coverage=${coverageViolations} usage=${usageMismatches} numericWithoutWeight=${numericUnknownWeights} crashes=${claudeCrashes.length}`,
  coverageViolations === 0 &&
    usageMismatches === 0 &&
    numericUnknownWeights === 0 &&
    claudeCrashes.length === 0,
)

for (const crash of [...codexCrashes, ...claudeCrashes].slice(0, 10)) console.error(`  ${crash}`)
if (failed) process.exit(1)

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}

function windowsForObservation(
  observation: LimitObservation,
  index: WindowIndex | undefined,
): LimitWindow[] {
  if (!index) return []
  const startsAt = observation.resetsAt - observation.windowMinutes * 60_000
  const tolerance = Math.max(120_000, observation.windowMinutes * 60_000 * 0.02)
  const matches: LimitWindow[] = []
  let position = lowerBound(index.starts, startsAt - tolerance)
  while (
    position < index.windows.length &&
    index.windows[position]!.startsAt <= startsAt + tolerance
  ) {
    matches.push(index.windows[position]!)
    position += 1
  }
  return matches
}

function containingWindows(at: number, index: WindowIndex | undefined): number {
  if (!index) return 0
  return upperBound(index.starts, at) - upperBound(index.resets, at)
}

function indexBy<K>(windows: LimitWindow[], key: (window: LimitWindow) => K): Map<K, WindowIndex> {
  const result = new Map<K, WindowIndex>()
  for (const [value, group] of groupBy(windows, key)) {
    const sorted = [...group].sort((left, right) => left.startsAt - right.startsAt)
    result.set(value, {
      windows: sorted,
      starts: sorted.map((window) => window.startsAt),
      resets: sorted.map((window) => window.resetsAt).sort((left, right) => left - right),
    })
  }
  return result
}

function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>()
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value])
  return result
}

function lowerBound(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

function upperBound(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! <= target) low = middle + 1
    else high = middle
  }
  return low
}

function compareSemver(left: string, right: string): number {
  const a = semverTriplet(left)
  const b = semverTriplet(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function semverTriplet(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (!match) return [-1, -1, -1]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function sumRequests(requests: Request[]): Omit<LimitUsage, 'weighted'> {
  return requests.reduce(
    (sum, request) => ({
      input: sum.input + request.input,
      output: sum.output + request.output,
      cacheWrite: sum.cacheWrite + request.cacheWrite,
      cacheRead: sum.cacheRead + request.cacheRead,
      requests: sum.requests + 1,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 },
  )
}

function sumWindowUsage(windows: LimitWindow[]): LimitUsage {
  return windows.reduce<LimitUsage>(
    (sum, window) => {
      const usage = window.usage
      if (!usage) return sum
      sum.input += usage.input
      sum.output += usage.output
      sum.cacheWrite += usage.cacheWrite
      sum.cacheRead += usage.cacheRead
      sum.requests += usage.requests
      sum.weighted = (sum.weighted ?? 0) + (usage.weighted ?? 0)
      return sum
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, weighted: 0, requests: 0 },
  )
}

function usageDifferences(
  actual: LimitUsage,
  expected: Omit<LimitUsage, 'weighted'>,
  cacheReadWeight: number,
): number {
  let differences = 0
  for (const field of ['input', 'output', 'cacheWrite', 'cacheRead', 'requests'] as const) {
    if (actual[field] !== expected[field]) differences += 1
  }
  const weighted =
    expected.input + expected.cacheWrite + expected.output + cacheReadWeight * expected.cacheRead
  if (actual.weighted === null || Math.abs(actual.weighted - weighted) > 1e-6) differences += 1
  return differences
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

function format(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
