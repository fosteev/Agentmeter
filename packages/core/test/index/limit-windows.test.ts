import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetSource,
  ingestAll,
  ingestFile,
  readLimitWindows,
  rebuildLimitWindows,
  type LimitWindow,
  type Provider,
  type SourceFile,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'
import type { ClaudeLimits } from '../../src/config/types.ts'

const fixturesDir = fileURLToPath(new URL('../../../../fixtures/limits/', import.meta.url))
const unknownLimits: ClaudeLimits = {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: null,
  plan: null,
}

interface ExpectedWindow extends Omit<
  LimitWindow,
  'provider' | 'startsAt' | 'resetsAt' | 'observedAt'
> {
  startsAt: string
  resetsAt: string
  observedAt: string
}

interface ExpectedCodex {
  provider: Provider
  windows: ExpectedWindow[]
}

interface ExpectedClaude {
  provider: Provider
  cases: {
    withWeightAndCaps: {
      config: Omit<ClaudeLimits, 'plan'>
      windows: ExpectedWindow[]
    }
  }
}

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-limit-index-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('окна лимита в индексе', () => {
  for (const name of ['codex-limits', 'codex-limits-new', 'codex-limits-odd']) {
    it(`проводит ${name} через парсер, базу и сборку без потерь`, () => {
      const expected = readExpected<ExpectedCodex>(name)
      ingestFixture(name, 'codex')

      rebuildLimitWindows(db, unknownLimits)

      expect(readLimitWindows(db)).toEqual(normalize(expected.provider, expected.windows))
    })
  }

  it('проводит Claude через базу со всеми сырыми суммами и null-семантикой', () => {
    const expected = readExpected<ExpectedClaude>('claude-limits')
    const limits: ClaudeLimits = { ...expected.cases.withWeightAndCaps.config, plan: null }
    ingestFixture('claude-limits', 'claude')

    rebuildLimitWindows(db, limits)

    expect(readLimitWindows(db)).toEqual(
      normalize(expected.provider, expected.cases.withWeightAndCaps.windows),
    )
  })

  it('объединяет независимые Codex-цепочки без изменения эталонных окон', () => {
    const names = ['codex-limits', 'codex-limits-new', 'codex-limits-odd'] as const
    for (const name of names) ingestFixture(name, 'codex')
    const expected = names.flatMap((name) => {
      const value = readExpected<ExpectedCodex>(name)
      return normalize(value.provider, value.windows)
    })

    rebuildLimitWindows(db, unknownLimits)

    expect(readLimitWindows(db)).toEqual(sortWindows(expected))
  })

  it('пересобирается идемпотентно', () => {
    ingestFixture('codex-limits', 'codex')
    rebuildLimitWindows(db, unknownLimits)
    const first = readLimitWindows(db)

    rebuildLimitWindows(db, unknownLimits)

    expect(readLimitWindows(db)).toEqual(first)
  })

  it('забытый источник уносит наблюдения и построенные из них окна', () => {
    const path = join(fixturesDir, 'codex-limits.jsonl')
    ingestFixture('codex-limits', 'codex')
    rebuildLimitWindows(db, unknownLimits)
    expect(readLimitWindows(db)).not.toHaveLength(0)

    forgetSource(db, path)
    rebuildLimitWindows(db, unknownLimits)

    expect(readLimitWindows(db)).toEqual([])
    expect(
      db.get<{ count: number }>('SELECT count(*) AS count FROM limit_observations')?.count,
    ).toBe(0)
  })

  it('ingestAll снимает окна файла, исчезнувшего между проходами', () => {
    const claudeHome = join(dir, '.claude')
    const codexHome = join(dir, '.codex')
    const day = join(codexHome, 'sessions', '2026', '05', '01')
    mkdirSync(join(claudeHome, 'projects'), { recursive: true })
    mkdirSync(day, { recursive: true })
    const path = join(day, 'rollout-limits.jsonl')
    copyFileSync(join(fixturesDir, 'codex-limits.jsonl'), path)
    ingestAll(db, { claudeHome, codexHome })
    expect(readLimitWindows(db)).not.toHaveLength(0)

    rmSync(path)
    ingestAll(db, { claudeHome, codexHome })

    expect(readLimitWindows(db)).toEqual([])
  })
})

function ingestFixture(name: string, provider: Provider): void {
  const path = join(fixturesDir, `${name}.jsonl`)
  const file: SourceFile = { path, provider, kind: 'session' }
  expect(ingestFile(db, file).parsed).toBe(true)
}

function readExpected<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.expected.json`), 'utf8')) as T
}

function normalize(provider: Provider, windows: ExpectedWindow[]): LimitWindow[] {
  return sortWindows(
    windows.map((window) => ({
      ...window,
      provider,
      startsAt: Date.parse(window.startsAt),
      resetsAt: Date.parse(window.resetsAt),
      observedAt: Date.parse(window.observedAt),
    })),
  )
}

function sortWindows(windows: LimitWindow[]): LimitWindow[] {
  return windows.sort(
    (left, right) =>
      left.startsAt - right.startsAt ||
      left.windowMinutes - right.windowMinutes ||
      left.resetsAt - right.resetsAt,
  )
}
