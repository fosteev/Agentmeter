/**
 * Проверка раскладки стартового префикса на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/prefix-live.ts
 */
import { readFileSync } from 'node:fs'
import {
  discoverSources,
  parseRolloutFile,
  parseSessionFile,
  type ParseResult,
  type PrefixBlock,
} from '../../packages/core/src/index.ts'
import type { SourceFile } from '../../packages/core/src/index/discover.ts'

interface ParsedFile {
  file: SourceFile
  result: ParseResult
}

const files = discoverSources().filter((file) => file.kind === 'session')
const parsed: ParsedFile[] = []
const crashes: string[] = []
let failed = false

for (const file of files) {
  try {
    parsed.push({
      file,
      result: file.provider === 'codex' ? parseRolloutFile(file.path) : parseSessionFile(file.path),
    })
  } catch (error) {
    crashes.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const measured = parsed.filter(({ result }) => result.session.prefixTokens > 0)
const identityFailures = measured.filter(
  ({ result }) => sumTokens(result.session.prefixBlocks) !== result.session.prefixTokens,
)
report(
  1,
  'тождество',
  `sessions=${measured.length} mismatches=${identityFailures.length} crashes=${crashes.length}`,
  identityFailures.length === 0 && crashes.length === 0,
)

const negativeResiduals = measured.filter(({ result }) => residual(result)?.tokens < 0)
const minimumResidual = Math.min(...measured.map(({ result }) => residual(result)?.tokens ?? 0))
report(
  2,
  'остаток положителен',
  `negative=${negativeResiduals.length} min=${minimumResidual}`,
  negativeResiduals.length === 0,
)

const claude = measured.filter(({ file }) => file.provider === 'claude')
const claudePairs = calibrationPairs(claude)
const claudePairMedian = median(claudePairs)
report(
  3,
  'парная сверка коэффициентов',
  `pairs=${claudePairs.length} median=${format(claudePairMedian, 3)} threshold=0.90..1.10`,
  claudePairs.length >= 300 && claudePairMedian >= 0.9 && claudePairMedian <= 1.1,
)

const stableGroups = stabilityGroups(claude)
const passingGroups = stableGroups.filter((group) => group.spread <= 0.1)
const worstPassing = Math.max(0, ...passingGroups.map((group) => group.spread))
report(
  4,
  'стабильность остатка',
  `groups=${stableGroups.length} passing=${passingGroups.length} maxPassing=${format(worstPassing * 100, 2)}% threshold=10%`,
  passingGroups.length >= 10,
)

const deferred = claude.filter(({ result }) => result.session.toolsDeferred)
const eager = claude.filter(({ result }) => !result.session.toolsDeferred)
const deferredMcpTokens = deferred.reduce(
  (sum, { result }) =>
    sum +
    tokensFor(result.session.prefixBlocks, 'mcpTools') *
      result.requests.filter((request) => request.origin === 'log').length,
  0,
)
const deferredPrefixTokens = deferred.reduce(
  (sum, { result }) =>
    sum +
    result.session.prefixTokens *
      result.requests.filter((request) => request.origin === 'log').length,
  0,
)
const mcpShare = percent(deferredMcpTokens, deferredPrefixTokens)
const eagerMcpBlocks = eager.reduce(
  (sum, { result }) =>
    sum + result.session.prefixBlocks.filter((block) => block.category === 'mcpTools').length,
  0,
)
report(
  5,
  'режим определяется',
  `deferred=${deferred.length} mcpShare=${format(mcpShare, 2)}% (<5%); eager=${eager.length} mcpBlocks=${eagerMcpBlocks}`,
  deferred.length > 0 && mcpShare < 5 && eagerMcpBlocks === 0,
)

const codex = measured.filter(({ file }) => file.provider === 'codex')
const codexIdentity = codex.filter(
  ({ result }) => sumTokens(result.session.prefixBlocks) !== result.session.prefixTokens,
)
const codexWithBase = codex.filter(({ file }) =>
  readFileSync(file.path, 'utf8').includes('"base_instructions"'),
)
const baseShare = percent(codexWithBase.length, codex.length)
const codexRatios = codex
  .map(({ result }) => {
    const estimated = result.session.prefixBlocks
      .filter((block) => block.basis === 'estimated')
      .reduce((sum, block) => sum + block.tokens, 0)
    return estimated > 0 ? result.session.prefixTokens / estimated : Number.NaN
  })
  .filter(Number.isFinite)
report(
  6,
  'Codex',
  `rollouts=${codex.length} identity=${codexIdentity.length} base=${codexWithBase.length} (${format(baseShare, 2)}%, >=95%) medianCtx/visible=${format(median(codexRatios), 3)} (справочно)`,
  codexIdentity.length === 0 && baseShare >= 95,
)

for (const crash of crashes.slice(0, 10)) console.error(`  ${crash}`)
for (const entry of negativeResiduals.slice(0, 10)) {
  console.error(`  negative: ${entry.file.path} ${residual(entry.result)?.tokens}`)
}
if (failed) process.exit(1)

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}

function sumTokens(blocks: PrefixBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokens, 0)
}

function residual(result: ParseResult): PrefixBlock | undefined {
  const category = result.session.provider === 'codex' ? 'toolSchemas' : 'system'
  return result.session.prefixBlocks.find(
    (block) => block.category === category && block.basis === 'residual',
  )
}

function tokensFor(blocks: PrefixBlock[], category: PrefixBlock['category']): number {
  return blocks
    .filter((block) => block.category === category)
    .reduce((sum, block) => sum + block.tokens, 0)
}

function calibrationPairs(entries: ParsedFile[]): number[] {
  const ratios: number[] = []
  for (const group of groups(entries).values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left]!.result.session
        const b = group[right]!.result.session
        const estimatedDelta = estimatedTokens(b.prefixBlocks) - estimatedTokens(a.prefixBlocks)
        if (Math.abs(estimatedDelta) < 800) continue
        ratios.push((b.prefixTokens - a.prefixTokens) / estimatedDelta)
      }
    }
  }
  return ratios.filter(Number.isFinite)
}

function stabilityGroups(entries: ParsedFile[]): Array<{ key: string; spread: number }> {
  const result: Array<{ key: string; spread: number }> = []
  for (const [key, group] of groups(entries)) {
    if (group.length < 5) continue
    const values = group.map(({ result: parsedResult }) => residual(parsedResult)?.tokens ?? 0)
    const center = median(values)
    const spread =
      center <= 0
        ? Number.POSITIVE_INFINITY
        : (quantile(values, 0.9) - quantile(values, 0.1)) / center
    result.push({ key, spread })
  }
  return result
}

function groups(entries: ParsedFile[]): Map<string, ParsedFile[]> {
  const result = new Map<string, ParsedFile[]>()
  for (const entry of entries) {
    const session = entry.result.session
    const key = `${session.cliVersion ?? 'unknown'}\u0000${session.model ?? 'unknown'}\u0000${session.project}`
    result.set(key, [...(result.get(key) ?? []), entry])
  }
  return result
}

function estimatedTokens(blocks: PrefixBlock[]): number {
  return blocks
    .filter((block) => block.basis === 'estimated')
    .reduce((sum, block) => sum + block.tokens, 0)
}

function median(values: number[]): number {
  return quantile(values, 0.5)
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const fraction = index - lower
  return sorted[lower]! + ((sorted[lower + 1] ?? sorted[lower]!) - sorted[lower]!) * fraction
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100
}

function format(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}
