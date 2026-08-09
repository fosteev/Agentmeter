import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildClaudeWindows,
  buildCodexWindows,
  currentWindows,
  parseRolloutFile,
  parseSessionFile,
  readLimits,
  type LimitUsage,
  type LimitWindow,
  type LimitWindowKind,
  type Provider,
  type Request,
} from '../src/index.ts'
import type { ClaudeLimits } from '../src/config/types.ts'

const fixturesDir = fileURLToPath(new URL('../../../fixtures/limits/', import.meta.url))

interface ExpectedWindow extends Omit<
  LimitWindow,
  'provider' | 'startsAt' | 'resetsAt' | 'observedAt'
> {
  startsAt: string
  resetsAt: string
  observedAt: string
}

interface ExpectedCurrent {
  at: string
  fiveHour: { startsAt: string; usedPercent: number } | null
  weekly: { startsAt: string; usedPercent: number } | null
}

interface ExpectedCodex {
  provider: Provider
  windows: ExpectedWindow[]
  current?: ExpectedCurrent
  currentAfterExpiry?: ExpectedCurrent
}

interface ExpectedClaudeConfig {
  fiveHourCap: number | null
  weeklyCap: number | null
  cacheReadWeight: number | null
}

interface ExpectedClaude {
  provider: Provider
  requests: { log: number; reconstructed: number }
  cases: {
    withWeightAndCaps: { config: ExpectedClaudeConfig; windows: ExpectedWindow[] }
    withoutWeight: {
      config: ExpectedClaudeConfig
      weighted: Array<number | null>
      usedPercent: Array<number | null>
    }
    withoutCaps: {
      config: ExpectedClaudeConfig
      weighted: Array<number | null>
      usedPercent: Array<number | null>
    }
  }
}

describe('limits', () => {
  for (const name of ['codex-limits', 'codex-limits-new', 'codex-limits-odd']) {
    it(`собирает окна Codex по ручному эталону ${name}`, () => {
      const expected = readExpected<ExpectedCodex>(name)
      const path = join(fixturesDir, `${name}.jsonl`)
      const parsed = parseRolloutFile(path)
      const observations = readLimits(path)
      const windows = buildCodexWindows([...observations].reverse())

      expect(parsed.session.provider).toBe(expected.provider)
      expect(windows).toEqual(normalizeWindows(expected.provider, expected.windows))

      if (expected.current) assertCurrent(windows, expected.current)
      if (expected.currentAfterExpiry) assertCurrent(windows, expected.currentAfterExpiry)
    })
  }

  it('собирает окна Claude по всем запросам и сохраняет неизвестные значения как null', () => {
    const expected = readExpected<ExpectedClaude>('claude-limits')
    const { session, requests } = parseSessionFile(join(fixturesDir, 'claude-limits.jsonl'))
    const recorded = requests.filter((request) => request.origin === 'log')
    const reconstructed = requests.filter((request) => request.origin === 'reconstructed')

    expect(session.provider).toBe(expected.provider)
    expect(recorded).toHaveLength(expected.requests.log)
    expect(reconstructed).toHaveLength(expected.requests.reconstructed)

    const withWeight = buildClaudeWindows(
      [...requests].reverse(),
      claudeConfig(expected.cases.withWeightAndCaps.config),
    )
    expect(withWeight).toEqual(
      normalizeWindows(expected.provider, expected.cases.withWeightAndCaps.windows),
    )

    const withoutWeight = buildClaudeWindows(
      requests,
      claudeConfig(expected.cases.withoutWeight.config),
    )
    expect(withoutWeight.map((window) => window.usage?.weighted)).toEqual(
      normalizeMetrics(
        expected.cases.withoutWeight.weighted,
        expected.cases.withWeightAndCaps.windows,
      ),
    )
    expect(withoutWeight.map((window) => window.usedPercent)).toEqual(
      normalizeMetrics(
        expected.cases.withoutWeight.usedPercent,
        expected.cases.withWeightAndCaps.windows,
      ),
    )
    expect(rawUsage(withoutWeight)).toEqual(rawUsage(withWeight))

    const withoutCaps = buildClaudeWindows(
      requests,
      claudeConfig(expected.cases.withoutCaps.config),
    )
    expect(withoutCaps.map((window) => window.usage?.weighted)).toEqual(
      normalizeMetrics(
        expected.cases.withoutCaps.weighted,
        expected.cases.withWeightAndCaps.windows,
      ),
    )
    expect(withoutCaps.map((window) => window.usedPercent)).toEqual(
      normalizeMetrics(
        expected.cases.withoutCaps.usedPercent,
        expected.cases.withWeightAndCaps.windows,
      ),
    )
  })

  it('не фильтрует isSidechain и synthetic', () => {
    const requests = [
      requestAt('2026-05-01T10:01:00.000Z', { synthetic: true, input: 20 }),
      requestAt('2026-05-01T10:00:00.000Z', { isSidechain: true, input: 10 }),
    ]
    const windows = buildClaudeWindows(requests, {
      fiveHourCap: null,
      weeklyCap: null,
      cacheReadWeight: 0.1,
      plan: null,
    })

    expect(windows).toHaveLength(2)
    for (const window of windows) {
      expect(window.usage).toMatchObject({ input: 30, requests: 2, weighted: 30 })
    }
  })
})

function readExpected<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.expected.json`), 'utf8')) as T
}

function normalizeWindows(provider: Provider, windows: ExpectedWindow[]): LimitWindow[] {
  return windows
    .map((window) => ({
      ...window,
      provider,
      startsAt: Date.parse(window.startsAt),
      resetsAt: Date.parse(window.resetsAt),
      observedAt: Date.parse(window.observedAt),
    }))
    .sort(
      (left, right) =>
        left.startsAt - right.startsAt ||
        left.windowMinutes - right.windowMinutes ||
        left.resetsAt - right.resetsAt,
    )
}

function normalizeMetrics<T>(values: T[], windows: ExpectedWindow[]): T[] {
  return windows
    .map((window, index) => ({ window, value: values[index]! }))
    .sort(
      (left, right) =>
        Date.parse(left.window.startsAt) - Date.parse(right.window.startsAt) ||
        left.window.windowMinutes - right.window.windowMinutes ||
        Date.parse(left.window.resetsAt) - Date.parse(right.window.resetsAt),
    )
    .map(({ value }) => value)
}

function assertCurrent(windows: LimitWindow[], expected: ExpectedCurrent): void {
  const actual = currentWindows(windows, Date.parse(expected.at))
  for (const kind of ['fiveHour', 'weekly'] as const satisfies readonly LimitWindowKind[]) {
    const value = expected[kind]
    if (value === null) {
      expect(actual[kind]).toBeUndefined()
    } else {
      expect(actual[kind]).toMatchObject({
        startsAt: Date.parse(value.startsAt),
        usedPercent: value.usedPercent,
      })
    }
  }
}

function claudeConfig(config: ExpectedClaudeConfig): ClaudeLimits {
  return { ...config, plan: null }
}

function rawUsage(windows: LimitWindow[]): Array<Omit<LimitUsage, 'weighted'>> {
  return windows.map((window) => {
    const usage = window.usage!
    return {
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      requests: usage.requests,
    }
  })
}

function requestAt(
  iso: string,
  overrides: Partial<Pick<Request, 'input' | 'isSidechain' | 'synthetic'>>,
): Request {
  return {
    sessionId: 'test',
    seq: 0,
    requestId: iso,
    ts: Date.parse(iso),
    model: 'test',
    origin: 'log',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    contextTokens: 0,
    isSidechain: false,
    compacted: false,
    synthetic: false,
    interjectedBytes: 0,
    tools: [],
    ...overrides,
  }
}
