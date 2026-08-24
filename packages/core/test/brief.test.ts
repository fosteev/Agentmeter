import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiBrief,
  briefMarkdown,
  ingestFile,
  locale,
  savings,
  setLocale,
  spendSplit,
  t,
  todayReport,
  toolBreakdownRows,
  type AiBrief,
  type DayRange,
  type SourceFile,
} from '../src/index.ts'
import { openDb, type Db } from '../src/index/db.ts'

/**
 * Бриф для ИИ (7.7).
 *
 * Главная поломка, которую ловят проверки, — второй счёт: бриф обязан совпасть
 * с экранами до токена, иначе внешний ИИ советует по числам, которых человек не
 * видел. Вторая — молчаливое усечение и потерянные пометки оценки: файл, где
 * нижняя оценка выглядит измеренной, нарушает границы честности продукта.
 */

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

let dir: string
let db: Db
let startLocale: 'ru' | 'en'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-brief-'))
  db = openDb(join(dir, 'index.sqlite')).db
  startLocale = locale()
  setLocale('ru')
})

afterEach(() => {
  setLocale(startLocale)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('aiBrief', () => {
  /** Ловит второй сбор «почти как на экране»: числа обязаны совпасть до токена. */
  it('числа брифа — те же, что на экранах', () => {
    fixtures()

    const brief = aiBrief(db, allTime)
    const report = todayReport(db, allTime)
    const split = spendSplit(db, allTime)

    expect(brief.totals).toEqual(report.totals)
    expect(brief.approximate).toBe(report.approximate)
    expect(brief.split).toEqual({
      total: split.total,
      recurring: split.recurring,
      marginal: split.marginal,
      firstRead: split.firstRead,
    })
    expect(brief.advice).toEqual(savings(db, allTime))
    const tools = toolBreakdownRows(db, { range: allTime })
    expect(brief.tools.map((tool) => tool.key)).toEqual(tools.map((row) => row.key))
    expect(brief.tools.reduce((sum, tool) => sum + tool.tokens, 0)).toBe(
      tools.reduce(
        (sum, row) => sum + row.tokens.measured + row.tokens.split + row.tokens.unknown,
        0,
      ),
    )
  })

  /** Ловит потерянную пометку оценки: нижняя оценка обязана быть названа в файле. */
  it('оценка названа словами, а итог едет точным числом', () => {
    fixtures()

    const brief = aiBrief(db, allTime)
    const markdown = briefMarkdown(brief)

    expect(brief.approximate).toBe(true)
    expect(markdown).toContain(t('brief.totalsApprox'))
    expect(markdown).toContain(String(brief.totals!.total))
  })

  /** Ловит пустой период, показанный нулями: отсутствие расхода — не ноль. */
  it('пустой период — отдельная фраза без разделов', () => {
    const brief = aiBrief(db, allTime)
    const markdown = briefMarkdown(brief)

    expect(brief.totals).toBeNull()
    expect(markdown).toContain(t('brief.empty'))
    expect(markdown).not.toContain(t('brief.splitTitle'))
  })

  /** Ловит бриф, застывший на языке запуска: язык меняется вызовом, не пересборкой. */
  it('маркдаун говорит на текущем языке', () => {
    fixtures()

    const brief = aiBrief(db, allTime)
    expect(briefMarkdown(brief)).toContain('## Правила чтения')
    setLocale('en')
    expect(briefMarkdown(brief)).toContain('## Reading rules')
  })
})

describe('briefMarkdown', () => {
  /**
   * Ловит молчаливое усечение: инструментов сверх лимита печати не «нет», а
   * «ещё N на столько-то» — явной строкой с их числом и суммой.
   */
  it('длинный список инструментов сворачивается с явным остатком', () => {
    const tools = Array.from({ length: 20 }, (_, index) => ({
      key: `tool-${index}`,
      calls: 1,
      tokens: 20 - index,
    }))
    const markdown = briefMarkdown(handMade(tools))

    expect(markdown).toContain('tool-14')
    expect(markdown).not.toContain('tool-15')
    expect(markdown).toContain(t('brief.toolsRest', { count: 5, tokens: 5 + 4 + 3 + 2 + 1 }))
  })
})

/** Бриф руками — только то, что нужно проверке усечения. */
function handMade(tools: AiBrief['tools']): AiBrief {
  return {
    range: { from: Date.parse('2026-08-01T00:00:00.000Z'), to: Date.parse('2026-08-02T00:00:00.000Z') },
    approximate: false,
    totals: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1, total: 4, requests: 1 },
    sessions: 1,
    split: { total: 4, recurring: 2, marginal: 2, firstRead: 2 },
    categories: [],
    advice: [],
    tools,
    cache: {
      measurable: false,
      ttlMs: 0,
      start: { count: 0, tokens: 0 },
      pause: { count: 0, tokens: 0 },
      early: { count: 0, tokens: 0 },
      compact: { count: 0, tokens: 0 },
      tokens: 0,
      worst: null,
    },
  }
}

function fixtures(): void {
  for (const name of ['compact', 'images', 'mcp', 'parallel', 'plain', 'sidechain']) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
}

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}
