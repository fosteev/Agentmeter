/**
 * Вкладка «История» (4.6) на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/history-live.ts
 *
 * Пять проверок. Главная — вторая: сумма клеток хитмапа обязана совпадать с
 * итогом столбика над ней и с шапкой «Сегодня» за те же сутки. Разойдись они,
 * и на экране окажутся три числа про один день, каждое настоящее по себе.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  DEFAULT_CONFIG,
  dayRange,
  ingestAll,
  openDb,
  todayReport,
} from '../../packages/core/src/index.ts'
import { buildHistoryScreen } from '../../apps/desktop/src/main/history.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-history-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))
const now = Date.now()

try {
  const ingest = ingestAll(db)
  const started = performance.now()
  const all = buildHistoryScreen(db, { span: 'all' }, DEFAULT_CONFIG, now)
  const week = buildHistoryScreen(db, { span: 'week' }, DEFAULT_CONFIG, now)
  const month = buildHistoryScreen(db, { span: 'month' }, DEFAULT_CONFIG, now)
  const ms = (performance.now() - started) / 3

  report(
    1,
    'экран собирается',
    `дней в «всё» ${all.days.length}, за неделю ${week.days.length}, за 30 дней ${month.days.length}, ` +
      `с расходом ${all.daysWithSpend}, собирается за ${ms.toFixed(0)} мс, ingest failed=${ingest.failed}`,
    ingest.failed === 0 && all.days.length > 0 && week.days.length === 7 && month.days.length === 30,
  )

  const mismatched = all.days.filter((day) => {
    if (day.tokens === null) return false
    const cells = day.hours.reduce((sum, hour) => sum + hour.tokens, 0)
    const header = todayReport(db, dayRange(day.at, DEFAULT_CONFIG.ui.dayStartsAtHour)).totals
    return cells !== day.tokens.value || (header?.total ?? 0) !== day.tokens.value
  })
  report(
    2,
    'столбик, клетки и шапка дня — одно число',
    `дней ${all.days.length}, расхождений ${mismatched.length}`,
    all.days.length > 0 && mismatched.length === 0,
  )

  const zero = all.days.filter((day) => day.tokens !== null && day.tokens.value === 0).length
  const absent = all.days.filter((day) => day.tokens === null).length
  const future = all.days.filter((day) => day.at > now).length
  report(
    3,
    'три пустоты различены',
    `с расходом ${all.days.length - zero - absent}, с нулём ${zero}, без данных ${absent}, ` +
      `из них в будущем ${future}`,
    zero > 0 && all.days.length - zero - absent === all.daysWithSpend,
  )

  // Клетка без расхода не имеет провайдера, клетка с расходом — имеет. Иначе
  // хитмап красит либо пустоту, либо работу в цвет «никого».
  const cells = all.days.flatMap((day) => day.hours)
  const painted = cells.filter((hour) => hour.tokens > 0 && hour.provider === null).length
  const empty = cells.filter((hour) => hour.tokens === 0 && hour.provider !== null).length
  report(
    4,
    'цвет клетки есть ровно там, где расход',
    `клеток ${cells.length}, с расходом без цвета ${painted}, пустых с цветом ${empty}`,
    cells.length > 0 && painted === 0 && empty === 0,
  )

  const summary = all.selected
  const day = summary === undefined ? null : todayReport(db, dayRange(summary.at, 0))
  report(
    5,
    'правая колонка про выбранный день',
    summary === undefined
      ? 'выбранного дня нет'
      : `${new Date(summary.at).toISOString().slice(0, 10)}: итог ${summary.total.value}, ` +
        `шапка ${day?.totals?.total ?? 0}, сессий ${summary.sessions}, задач ${summary.tasks}, ` +
        `медиана постоянного ${summary.splitMedian === undefined ? '—' : `${(summary.splitMedian * 100).toFixed(1)}%`}`,
    summary !== undefined &&
      summary.total.value === (day?.totals?.total ?? 0) &&
      summary.tokens.reduce((sum, slice) => sum + slice.tokens.value, 0) === summary.total.value,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exit(1)

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
