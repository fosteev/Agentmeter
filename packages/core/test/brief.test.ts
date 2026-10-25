import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  SPEED,
  spendMatrix,
  spendSplit,
  t,
  todayReport,
  toolBreakdownRows,
  type AiBrief,
  type DayRange,
  type MatrixCell,
  type MatrixRow,
  type SourceFile,
  type SpendMatrix,
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
const matrixDir = fileURLToPath(new URL('../../../fixtures/matrix/', import.meta.url))
const speedDir = fileURLToPath(new URL('../../../fixtures/speed/', import.meta.url))
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

/**
 * Разрез «проект × модель» в брифе (8.3).
 *
 * Эталоны — `fixtures/matrix/` (клетки) и `fixtures/speed/` (скорость): числа
 * посчитаны руками до кода, и бриф сверяется с ними, а не с собственным выводом.
 * Второй слой — равенство с `spendMatrix` той же функцией: бриф не имеет права
 * считать разрез «почти как окно».
 */
describe('бриф: модели и проекты', () => {
  const matrixRange: DayRange = {
    from: Date.parse('2026-08-01T00:00:00.000Z'),
    to: Date.parse('2026-09-01T00:00:00.000Z'),
  }
  const speedRange: DayRange = {
    from: Date.parse('2026-09-01T00:00:00.000Z'),
    to: Date.parse('2026-09-02T00:00:00.000Z'),
  }
  const expected = JSON.parse(readFileSync(join(matrixDir, 'expected.json'), 'utf8')) as {
    cases: Array<{ name: string; matrix: SpendMatrix }>
  }

  function seedMatrixAndSpeed(): void {
    for (const [dir, name, provider] of [
      [matrixDir, 'claude-alpha', 'claude'],
      [matrixDir, 'claude-beta', 'claude'],
      [matrixDir, 'codex-alpha', 'codex'],
      [speedDir, 'claude-alpha', 'claude'],
      [speedDir, 'codex-alpha', 'codex'],
    ] as const) {
      ingest({ path: join(dir, `${name}.jsonl`), provider, kind: 'session' })
    }
  }

  /** Ловит свой GROUP BY в брифе: поля обязаны равняться маргинали и строкам ядра, и ручному эталону. */
  it('models и projects — маргиналь и строки spendMatrix, а не их копия', () => {
    seedMatrixAndSpeed()

    const brief = aiBrief(db, matrixRange)
    const matrix = spendMatrix(db, matrixRange)
    const reference = expected.cases.find((item) => item.name === 'всё время')!.matrix

    expect(brief.models).toEqual(matrix.models)
    expect(brief.projects).toEqual(matrix.rows)
    expect(brief.models).toEqual(reference.models)
    expect(brief.projects).toEqual(reference.rows)
    expect(cellOf(brief.projects[0]!.cells, 'claude-fable-5').totals.total).toBe(5920)
    expect(brief.models.reduce((sum, cell) => sum + cell.totals.total, 0)).toBe(12270)
    expect(brief.totals!.total).toBe(12270)
  })

  it('раздел стоит после инструментов и перед кэшем, строки моделей говорят цифрами и словами', () => {
    seedMatrixAndSpeed()
    const markdown = briefMarkdown(aiBrief(db, matrixRange))

    expect(markdown.indexOf(t('brief.modelsTitle'))).toBeGreaterThan(-1)
    expect(markdown.indexOf(t('brief.modelsTitle'))).toBeLessThan(markdown.indexOf(t('brief.cacheTitle')))
    const fable = lineWith(markdown, 'claude-fable-5 (claude)')
    expect(fable).toContain('токенов 5920')
    expect(fable).toContain('доля периода 48.2%') // 5920 / 12270
    expect(fable).toContain('запросов 3')
    // Унаследованная модель — словами, с числом: 1800 из 5920.
    expect(fable).toContain(t('brief.modelInherited', { tokens: 1800 }))
    // У клетки без восстановленных запросов оговорки нет вовсе.
    expect(lineWith(markdown, 'claude-opus-5 (claude)')).not.toContain('восстановленными')
    expect(lineWith(markdown, 'gpt-5.6-sol (codex)')).toContain('токенов 2750')
  })

  it('раздел «Модели и проекты» идёт после «Разового расхода по инструментам»', () => {
    fixtures()
    const markdown = briefMarkdown(aiBrief(db, allTime))

    const tools = markdown.indexOf(t('brief.toolsTitle'))
    expect(tools).toBeGreaterThan(-1)
    expect(markdown.indexOf(t('brief.modelsTitle'))).toBeGreaterThan(tools)
    expect(markdown.indexOf(t('brief.cacheTitle'))).toBeGreaterThan(markdown.indexOf(t('brief.modelsTitle')))
  })

  it('проекты: токены, доля периода, запросы и модели с долями проекта', () => {
    seedMatrixAndSpeed()
    const markdown = briefMarkdown(aiBrief(db, matrixRange))

    expect(markdown).toContain(t('brief.projectsTitle'))
    const alpha = lineWith(markdown, '- alpha:')
    expect(alpha).toContain('токенов 11090')
    expect(alpha).toContain('доля периода 90.4%') // 11090 / 12270
    expect(alpha).toContain('запросов 7')
    // Доли моделей — от проекта: 5920 / 11090, 2750 / 11090, 2420 / 11090.
    expect(alpha).toContain('claude-fable-5 53.4%, gpt-5.6-sol 24.8%, claude-opus-5 21.8%')
    expect(lineWith(markdown, '- beta:')).toContain('claude-opus-5 100.0%')
  })

  it('скорость: медиана и p90 в секундах до десятых, темп, число запросов; ниже порога — словами', () => {
    seedMatrixAndSpeed()
    const markdown = briefMarkdown(aiBrief(db, speedRange))

    expect(lineWith(markdown, 'claude-opus-5 (claude)')).toContain(
      t('brief.modelSpeed', { p50: 5.5, p90: 9, pace: 40, count: 6 }),
    )
    expect(lineWith(markdown, 'gpt-5.6-sol (codex)')).toContain(
      t('brief.modelSpeed', { p50: 4.5, p90: 6.5, pace: 75, count: 6 }),
    )
    const sonnet = lineWith(markdown, 'claude-sonnet-5 (claude)')
    expect(sonnet).toContain(t('brief.modelSpeedFew', { min: SPEED.minRequests }))
    expect(sonnet).not.toContain('медиана')
  })

  /** Ловит бриф, потерявший правила: числа разреза без них — приглашение «смени модель». */
  it('правила ruleModels и ruleSpeed едут в файле между кэшем и оценкой', () => {
    seedMatrixAndSpeed()
    const markdown = briefMarkdown(aiBrief(db, matrixRange))

    const cache = markdown.indexOf(t('brief.ruleCache'))
    const models = markdown.indexOf(t('brief.ruleModels'))
    const speed = markdown.indexOf(t('brief.ruleSpeed'))
    const approx = markdown.indexOf(t('brief.ruleApprox'))
    expect(models).toBeGreaterThan(cache)
    expect(speed).toBeGreaterThan(models)
    expect(approx).toBeGreaterThan(speed)
    expect(markdown).toContain('Советовать сменить модель по этим числам нельзя')
    expect(markdown).toContain('Это не скорость генерации')
  })

  it('усечение — явной строкой: 12 проектов и 12 моделей при лимитах 10', () => {
    const models = Array.from({ length: 12 }, (_, index) => cell(`model-${index}`, 100 - index))
    const projects = Array.from({ length: 12 }, (_, index) => ({
      project: `project-${index}`,
      totals: totals(100 - index),
      cells: [cell('model-0', 100 - index)],
    }))
    const markdown = briefMarkdown(handMade([], { models, projects }))

    expect(markdown).toContain('model-9 (claude)')
    expect(markdown).not.toContain('model-10 (claude)')
    expect(markdown).toContain(t('brief.modelsRest', { count: 2, tokens: 90 + 89 }))
    expect(markdown).toContain('- project-9:')
    expect(markdown).not.toContain('- project-10:')
    expect(markdown).toContain(t('brief.projectsRest', { count: 2, tokens: 90 + 89 }))
  })

  it('ровно по лимиту — без строки «…и ещё»', () => {
    const models = Array.from({ length: 10 }, (_, index) => cell(`model-${index}`, 100 - index))
    const projects = models.map((one, index) => ({
      project: `project-${index}`,
      totals: one.totals,
      cells: [one],
    }))
    const markdown = briefMarkdown(handMade([], { models, projects }))

    expect(markdown).toContain('model-9 (claude)')
    expect(markdown).not.toContain(t('brief.modelsRest', { count: 0, tokens: 0 }).slice(0, 8))
    expect(markdown).not.toMatch(/…и ещё (моделей|проектов)/)
  })

  it('проект без имени печатается словами, а не пустотой', () => {
    const markdown = briefMarkdown(
      handMade([], {
        models: [cell('model-0', 4)],
        projects: [{ project: '', totals: totals(4), cells: [cell('model-0', 4)] }],
      }),
    )

    expect(markdown).toContain(`- ${t('matrix.noProject')}:`)
  })

  /** Ловит раздел в брифе без запросов: «ни расхода, ни моделей» — одна фраза. */
  it('пустой период — без раздела моделей', () => {
    const markdown = briefMarkdown(aiBrief(db, matrixRange))
    expect(markdown).not.toContain(t('brief.modelsTitle'))
    expect(markdown).not.toContain(t('brief.ruleModels'))
  })
})

function cell(model: string, total: number): MatrixCell {
  return { model, provider: 'claude', totals: totals(total), inherited: 0 }
}

function totals(total: number): MatrixRow['totals'] {
  return { input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, requests: 1 }
}

function cellOf(cells: readonly MatrixCell[], model: string): MatrixCell {
  const found = cells.find((candidate) => candidate.model === model)
  if (found === undefined) throw new Error(`нет клетки ${model}`)
  return found
}

function lineWith(markdown: string, needle: string): string {
  const line = markdown.split('\n').find((candidate) => candidate.includes(needle))
  if (line === undefined) throw new Error(`в брифе нет строки с «${needle}»`)
  return line
}

/** Бриф руками — только то, что нужно проверке усечения. */
function handMade(tools: AiBrief['tools'], extra: Partial<AiBrief> = {}): AiBrief {
  return {
    range: { from: Date.parse('2026-08-01T00:00:00.000Z'), to: Date.parse('2026-08-02T00:00:00.000Z') },
    approximate: false,
    totals: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1, total: 4, requests: 1 },
    sessions: 1,
    split: { total: 4, recurring: 2, marginal: 2, firstRead: 2 },
    categories: [],
    advice: [],
    tools,
    models: [],
    projects: [],
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
    ...extra,
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
