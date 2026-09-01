/**
 * Клетка «проект × модель» (8.1).
 *
 * Проверка двухслойная, и слои разные по существу. Первый — эталон
 * `fixtures/matrix/`, где каждая клетка посчитана человеком в `README.md`:
 * только он ловит группировку, которая сошлась с итогом периода и при этом
 * положила расход не в ту клетку. Второй — три равенства на всех больших
 * фикстурах, где есть сабагент и два провайдера: сумма строк, сумма моделей и
 * итог обязаны совпасть между собой и с `todayReport` до токена.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ingestFile,
  projectRowLabel,
  spendMatrix,
  todayReport,
  type DayRange,
  type MatrixCell,
  type RequestScope,
  type SourceFile,
  type SpendMatrix,
  type Totals,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

const claudeDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const matrixDir = fileURLToPath(new URL('../../../../fixtures/matrix/', import.meta.url))
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

interface ExpectedCase {
  name: string
  from: string
  to: string
  scope: RequestScope
  matrix: SpendMatrix
}

const expected = JSON.parse(readFileSync(join(matrixDir, 'expected.json'), 'utf8')) as {
  cases: ExpectedCase[]
}

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-matrix-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('матрица «проект × модель»', () => {
  it.each(expected.cases)('сходится с ручным расчётом: $name', (value) => {
    ingestMatrixFixture()

    const range = { from: Date.parse(value.from), to: Date.parse(value.to) }

    expect(spendMatrix(db, range, value.scope)).toEqual(value.matrix)
  })

  /**
   * Главная ловушка этапа: у сессии из эталона `sessions.model` равен
   * `claude-opus-5`, а три запроса из пяти сделаны `claude-fable-5`. Группировка
   * по модели сессии сошлась бы с итогом периода до токена — и соврала бы
   * клеткой. Здесь это утверждается прямо, чтобы поломка называлась своим
   * именем, а не «клетка 5920 против 2420».
   */
  it('считает по модели запроса, а не по модели сессии', () => {
    ingestMatrixFixture()

    const alpha = spendMatrix(db, allTime).rows.find((row) => row.project === 'alpha')
    const sessionModels = db
      .all<{ model: string }>('SELECT DISTINCT model FROM sessions WHERE project = ?', 'alpha')
      .map((row) => row.model)

    expect(sessionModels).toEqual(['claude-opus-5', 'gpt-5.6-sol'])
    expect(cell(alpha!.cells, 'claude-fable-5').totals.total).toBe(5920)
    expect(cell(alpha!.cells, 'claude-opus-5').totals.total).toBe(2420)
  })

  /**
   * Восстановленные запросы (1.3) — токены измерены, модель унаследована.
   * Отбор идёт по `origin`, и это не придирка к стилю: колонка `synthetic`
   * рядом на живой машине совпадает с ним один в один (599 и 599), а модель с
   * именем `<synthetic>` — это семь совсем других запросов.
   */
  it('наследованные токены считаются по origin и лежат только в своей клетке', () => {
    ingestMatrixFixture()

    const matrix = spendMatrix(db, allTime)
    const alpha = matrix.rows.find((row) => row.project === 'alpha')!

    expect(cell(alpha.cells, 'claude-fable-5').inherited).toBe(1800)
    expect(cell(alpha.cells, 'claude-opus-5').inherited).toBe(0)
    expect(cell(matrix.models, 'claude-fable-5').inherited).toBe(1800)
    // Клетка целиком из восстановленного расхода не бывает точнее своей строки:
    // 1800 из 5920 — это то самое «≈ на модели и не на итоге проекта».
    expect(alpha.cells.reduce((sum, row) => sum + row.inherited, 0)).toBe(1800)
  })

  it('сортирует строки и клетки по убыванию расхода', () => {
    ingestMatrixFixture()

    const matrix = spendMatrix(db, allTime)

    expect(matrix.rows.map((row) => row.project)).toEqual(['alpha', 'beta'])
    expect(matrix.rows[0]!.cells.map((row) => row.model)).toEqual([
      'claude-fable-5',
      'gpt-5.6-sol',
      'claude-opus-5',
    ])
    // Порядок маргинали не обязан повторять порядок клеток внутри строки:
    // `claude-opus-5` собран из двух проектов и обгоняет `gpt-5.6-sol`.
    expect(matrix.models.map((row) => row.model)).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'gpt-5.6-sol',
    ])
  })

  /**
   * Три равенства на данных, где есть сабагент, два провайдера и восстановленные
   * запросы. Сабагент здесь и есть предмет проверки: сворачивать его, как в
   * ленте, значит сложить ребёнка с родителем руками — клетка агрегирует
   * запросы, а каждый запрос принадлежит ровно одной сессии.
   */
  it('сумма строк = сумма моделей = итог = итог todayReport', () => {
    ingestAllFixtures()

    for (const scope of [
      {},
      { provider: 'claude' } as const,
      { provider: 'codex' } as const,
      { project: 'a' },
    ]) {
      const matrix = spendMatrix(db, allTime, scope)
      const day = todayReport(db, allTime, scope)

      // Иначе проверка держится на пустоте: три нуля сходятся между собой при
      // любой группировке.
      expect(matrix.totals.requests).toBeGreaterThan(0)
      expect(sum(matrix.rows)).toEqual(matrix.totals)
      expect(sum(matrix.models)).toEqual(matrix.totals)
      expect(matrix.totals).toEqual(day.totals ?? emptyTotals())
      // Клеток столько же, сколько пар «проект × модель» в самих данных:
      // потерянная строка не даёт расхождения сумм, если её расход нулевой.
      expect(matrix.rows.reduce((count, row) => count + row.cells.length, 0)).toBe(pairCount(scope))
    }
  })

  it('различает пустой индекс и отсёкший всё фильтр', () => {
    const empty = spendMatrix(db, allTime)

    expect(empty.emptyIndex).toBe(true)
    expect(empty.emptyScope).toBe(true)

    ingestMatrixFixture()
    const filtered = spendMatrix(db, allTime, { project: 'нет такого' })

    expect(filtered.emptyIndex).toBe(false)
    expect(filtered.emptyScope).toBe(true)
    expect(filtered.rows).toEqual([])
    expect(filtered.models).toEqual([])
    expect(filtered.totals.total).toBe(0)
  })

  it('строка без проекта называется словами, а ключом остаётся пустая строка', () => {
    expect(projectRowLabel('')).not.toBe('')
    expect(projectRowLabel('alpha')).toBe('alpha')
  })
})

function ingestMatrixFixture(): void {
  ingest({ path: join(matrixDir, 'claude-alpha.jsonl'), provider: 'claude', kind: 'session' })
  ingest({ path: join(matrixDir, 'codex-alpha.jsonl'), provider: 'codex', kind: 'session' })
  ingest({ path: join(matrixDir, 'claude-beta.jsonl'), provider: 'claude', kind: 'session' })
}

function ingestAllFixtures(): void {
  for (const name of [
    'compact',
    'images',
    'mcp',
    'parallel',
    'plain',
    'sidechain',
    'version-mid',
    'version-old',
  ]) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({
    path: join(claudeDir, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
    provider: 'claude',
    kind: 'subagent',
    parentPath: join(claudeDir, '92cc27dc-193d-4c2c-aef1-843d7d41aeab.jsonl'),
  })
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
}

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

function cell(cells: readonly MatrixCell[], model: string): MatrixCell {
  const found = cells.find((row) => row.model === model)
  expect(found, `клетки ${model} нет вовсе`).toBeDefined()
  return found!
}

/** Сколько пар «проект × модель» в данных — считается мимо самой матрицы. */
function pairCount(scope: RequestScope): number {
  const where = ['1 = 1']
  const params: string[] = []
  if (scope.provider !== undefined) {
    where.push('sessions.provider = ?')
    params.push(scope.provider)
  }
  if (scope.project !== undefined) {
    where.push('sessions.project = ?')
    params.push(scope.project)
  }
  return db.get<{ count: number }>(
    `SELECT count(*) AS count FROM (
       SELECT 1 FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE ${where.join(' AND ')}
       GROUP BY sessions.project, sessions.provider, requests.model)`,
    ...params,
  )!.count
}

function sum(rows: ReadonlyArray<{ totals: Totals }>): Totals {
  return rows.reduce(
    (acc, row) => ({
      input: acc.input + row.totals.input,
      output: acc.output + row.totals.output,
      cacheWrite: acc.cacheWrite + row.totals.cacheWrite,
      cacheRead: acc.cacheRead + row.totals.cacheRead,
      total: acc.total + row.totals.total,
      requests: acc.requests + row.totals.requests,
    }),
    emptyTotals(),
  )
}

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0 }
}
