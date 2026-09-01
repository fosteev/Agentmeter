/**
 * Клетка «проект × модель» (8.1) на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/matrix-live.ts
 *
 * Главное здесь — три равенства: сумма строк, сумма моделей и итог матрицы
 * обязаны совпасть между собой и с итогом `todayReport` за тот же период с тем
 * же сужением. До токена, а не «в пределах процента»: расхождение в 0.3% — это
 * ровно потерянный провайдер или задвоенный сабагент, и выглядит оно на экране
 * так же уверенно, как правда.
 *
 * Индекс собирается заново во временный каталог, как в остальных пробах: живой
 * индекс приложения — рабочий файл, и проба, пишущая в него, однажды объяснит
 * поломку продукта собой.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  ingestAll,
  openDb,
  spendMatrix,
  todayReport,
  type Db,
  type DayRange,
  type RequestScope,
  type SpendMatrix,
  type Totals,
} from '../../packages/core/src/index.ts'

const EMPTY: Totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0 }

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-matrix-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  ingestAll(db)
  const week = lastDays(7)
  const days = daysWithSpend(db)
  const scopes: RequestScope[] = [
    {},
    { provider: 'claude' },
    { provider: 'codex' },
    ...topProjects(db, week).map((project) => ({ project })),
  ]

  const started = performance.now()
  const matrix = spendMatrix(db, week)
  const ms = performance.now() - started
  const cells = matrix.rows.reduce((count, row) => count + row.cells.length, 0)
  report(
    1,
    'период раскладывается',
    `${new Date(week.from).toISOString().slice(0, 10)}…${new Date(week.to).toISOString().slice(0, 10)}: ` +
      `${tokens(matrix.totals.total)} за ${matrix.totals.requests} запросов, ` +
      `проектов ${matrix.rows.length}, моделей ${matrix.models.length}, клеток ${cells}, ` +
      `собирается за ${ms.toFixed(1)} мс`,
    matrix.rows.length > 0 && matrix.models.length > 0 && ms < 16,
  )
  for (const row of matrix.models) {
    console.log(
      `    ${row.model} [${row.provider}] ${tokens(row.totals.total)} · ` +
        `${share(row.totals.total, matrix.totals.total)} · ${row.totals.requests} запросов · ` +
        `ср. ${tokens(Math.round(row.totals.total / Math.max(1, row.totals.requests)))}`,
    )
  }
  for (const row of matrix.rows.slice(0, 5)) {
    console.log(
      `    ${row.project}: ${tokens(row.totals.total)} · ${share(row.totals.total, matrix.totals.total)} · ` +
        `моделей ${row.cells.length} · наследовано ${share(inherited(row.cells), row.totals.total)}`,
    )
  }

  // ─── три равенства ────────────────────────────────────────────────────────
  const broken: string[] = []
  let checked = 0
  for (const range of [week, ...days]) {
    for (const scope of scopes) {
      const value = spendMatrix(db, range, scope)
      const day = todayReport(db, range, scope).totals ?? EMPTY
      checked += 1
      const rows = sum(value.rows)
      const models = sum(value.models)
      const label = `${new Date(range.from).toISOString().slice(0, 10)} ${describe(scope)}`
      if (!same(rows, value.totals))
        broken.push(`${label}: строки ${rows.total} против ${value.totals.total}`)
      else if (!same(models, value.totals))
        broken.push(`${label}: модели ${models.total} против ${value.totals.total}`)
      else if (!same(value.totals, day))
        broken.push(`${label}: итог ${value.totals.total} против дневного ${day.total}`)
    }
  }
  report(
    2,
    'сумма строк = сумма моделей = итог = итог todayReport',
    `сверок ${checked} (дней ${days.length}, сужений ${scopes.length}), расхождений ${broken.length}` +
      (broken.length > 0 ? `: ${broken.slice(0, 3).join('; ')}` : ''),
    checked > 0 && broken.length === 0,
  )

  // ─── клеток столько же, сколько пар в самих данных ────────────────────────
  //
  // Сумма от потерянной пары не пострадает, если расход у неё нулевой, — а на
  // экране строки не будет. Поэтому счёт клеток берётся мимо матрицы.
  const lost = days.filter((range) => {
    const value = spendMatrix(db, range)
    const count = value.rows.reduce((total, row) => total + row.cells.length, 0)
    return count !== pairCount(db, range)
  }).length
  report(3, 'ни одна пара не потерялась', `дней ${days.length}, разошлось ${lost}`, lost === 0)

  // ─── сужение доезжает до клеток ───────────────────────────────────────────
  //
  // Матрица по провайдерам, сложенная обратно, обязана дать матрицу без
  // сужения. Свой `WHERE`, разъехавшись с лентой на один знак сравнения, здесь
  // и всплывёт.
  const scoped = days.filter((range) => {
    const whole = spendMatrix(db, range).totals.total
    const parts = (['claude', 'codex'] as const).reduce(
      (total, provider) => total + spendMatrix(db, range, { provider }).totals.total,
      0,
    )
    const projects = spendMatrix(db, range).rows.reduce(
      (total, row) => total + spendMatrix(db, range, { project: row.project }).totals.total,
      0,
    )
    return parts !== whole || projects !== whole
  }).length
  report(4, 'сужение доезжает', `дней ${days.length}, сломано ${scoped}`, scoped === 0)

  // ─── модель запроса против модели сессии ──────────────────────────────────
  //
  // Ловушка этапа: `sessions.model` — модель первого запроса сессии, и на живых
  // логах она расходится с настоящей. Проба утверждает, что расхождение есть:
  // исчезни оно — и эталон 8.1 перестанет что-либо проверять, а мы об этом
  // узнаем здесь, а не из тихой ошибки на чужой машине.
  const switched = db.get<{ sessions: number }>(
    `SELECT count(*) AS sessions FROM (
       SELECT requests.session_id FROM requests
       GROUP BY requests.session_id HAVING count(DISTINCT requests.model) > 1)`,
  )!
  const models = db.get<{ count: number }>('SELECT count(DISTINCT model) AS count FROM requests')!
  report(
    5,
    'модель меняется внутри сессии',
    `сессий с двумя и более моделями ${switched.sessions}, всего моделей в логах ${models.count}`,
    switched.sessions > 0 && models.count > matrix.models.length,
  )

  // ─── наследованное: доля измерена и не больше клетки ──────────────────────
  const cellsAll = matrix.rows.flatMap((row) => row.cells)
  const over = cellsAll.filter((cell) => cell.inherited > cell.totals.total).length
  const shares = matrix.rows
    .map((row) => inherited(row.cells) / Math.max(1, row.totals.total))
    .sort((left, right) => left - right)
  const mismatched = db.get<{ count: number }>(
    "SELECT count(*) AS count FROM requests WHERE (origin != 'log') != (synthetic = 1)",
  )!
  // Сумма наследованного берётся из индекса напрямую: без неё проверка молчит
  // на нуле, а ноль здесь — самая правдоподобная поломка (отбор по имени модели
  // `<synthetic>` вместо `origin` даёт ровно его).
  const expected = db.get<{ tokens: number }>(
    `SELECT coalesce(sum(requests.input + requests.output + requests.cache_write +
                         requests.cache_read), 0) AS tokens
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE requests.ts >= ? AND requests.ts < ? AND requests.origin != 'log'`,
    week.from,
    week.to,
  )!
  report(
    6,
    'наследованные токены на месте',
    `клеток ${cellsAll.length}, наследовано в ${cellsAll.filter((cell) => cell.inherited > 0).length}; ` +
      `${tokens(inherited(cellsAll))} против ${tokens(expected.tokens)} в индексе; ` +
      `по строкам ${percent(shares[0])}…${percent(shares.at(-1))}; ` +
      `origin против флага synthetic расходятся у ${mismatched.count} запросов`,
    over === 0 &&
      expected.tokens > 0 &&
      inherited(cellsAll) === expected.tokens &&
      inherited(matrix.models) === expected.tokens &&
      shares.at(-1)! < 0.5,
  )

  // ─── пустоты: их три, и различить их надо словами ─────────────────────────
  const emptyDay = { from: week.to + 86_400_000, to: week.to + 2 * 86_400_000 }
  const filtered = spendMatrix(db, week, { project: 'нет такого проекта' })
  const nothing = spendMatrix(db, emptyDay)
  report(
    7,
    'пустоты различаются',
    `фильтр отсёк всё: emptyScope=${filtered.emptyScope} emptyIndex=${filtered.emptyIndex}; ` +
      `будущий день: emptyScope=${nothing.emptyScope}`,
    filtered.emptyScope &&
      !filtered.emptyIndex &&
      filtered.rows.length === 0 &&
      nothing.emptyScope &&
      matrix.emptyScope === false,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exit(1)

/** Последние N суток, календарно и по локальному времени, как везде в продукте. */
function lastDays(count: number): DayRange {
  const to = new Date()
  to.setHours(0, 0, 0, 0)
  const from = new Date(to)
  from.setDate(from.getDate() - count)
  return { from: from.getTime(), to: to.getTime() }
}

function daysWithSpend(db: Db): DayRange[] {
  const rows = db.all<{ day: string }>(
    `SELECT DISTINCT date(requests.ts / 1000, 'unixepoch', 'localtime') AS day FROM requests`,
  )
  return rows.map(({ day }) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number]
    return {
      from: new Date(year, month - 1, date).getTime(),
      to: new Date(year, month - 1, date + 1).getTime(),
    }
  })
}

/** Проекты, по которым имеет смысл сужать: пустой список сделал бы проверку 2 слабее. */
function topProjects(db: Db, range: DayRange): string[] {
  return spendMatrix(db, range)
    .rows.slice(0, 3)
    .map((row) => row.project)
}

/** Пары «проект × модель» в самих данных — счёт мимо матрицы. */
function pairCount(db: Db, range: DayRange): number {
  return db.get<{ count: number }>(
    `SELECT count(*) AS count FROM (
       SELECT 1 FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE requests.ts >= ? AND requests.ts < ?
       GROUP BY sessions.project, sessions.provider, requests.model)`,
    range.from,
    range.to,
  )!.count
}

function inherited(cells: SpendMatrix['models']): number {
  return cells.reduce((total, cell) => total + cell.inherited, 0)
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
    { ...EMPTY },
  )
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

function describe(scope: RequestScope): string {
  if (scope.provider !== undefined) return scope.provider
  if (scope.project !== undefined) return `проект ${scope.project}`
  return 'весь период'
}

function tokens(value: number): string {
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : `${(value / 1e3).toFixed(1)}k`
}

function share(value: number, whole: number): string {
  return whole === 0 ? 'n/a' : percent(value / whole)
}

function percent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(2)}%`
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
