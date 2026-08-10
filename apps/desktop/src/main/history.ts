/**
 * Вкладка «История» (4.6) — разделы 8 и 8б макета.
 *
 * Тот же довод, что у `day.ts` и `breakdown.ts`: считается здесь и только
 * здесь. Окну остаётся высота столбика против самого высокого и насыщенность
 * клетки против самой густой — длины внутри своих диаграмм.
 *
 * Правая колонка собирается из тех же функций, что вкладка «Сегодня»: это тот
 * же день, только выбранный не сегодняшним. Второй сборкой «почти как в
 * `day.ts`» она разошлась бы с первой на первой же правке — и разошлась бы
 * молча, потому что сравнить их человеку негде: они на разных вкладках.
 */
import {
  dayRange,
  historyReport,
  spendSplit,
  sourceCount,
  t,
  taskRows,
  todayReport,
  type Config,
  type Db,
  type HistoryReport,
  type Provider,
} from '@agentmeter/core'
import { locale } from '@agentmeter/core/i18n'
import type {
  HistoryDay,
  HistoryDaySummary,
  HistoryScreen,
  HistorySpan,
  Measured,
  ProjectRow,
  TokenSlice,
} from '@agentmeter/ipc'
import { toSpendSplit } from './day.ts'
import { lowerBound, measured } from './measured.ts'

/** Сколько суток показывает каждый режим. `all` — всё, что есть в индексе. */
const SPAN_DAYS = { week: 7, month: 30 } as const

/** Сколько проектов в правой колонке показывается поимённо. */
const KEEP_PROJECTS = 4

export interface HistoryArg {
  span: HistorySpan
  /** Какой день раскрыт. Нет — последний день периода с расходом. */
  at?: number
}

export function buildHistoryScreen(
  db: Db,
  arg: HistoryArg,
  config: Config,
  now: number,
): HistoryScreen {
  const hour = config.ui.dayStartsAtHour
  const range = spanRange(db, arg.span, hour, now)
  const report = historyReport(db, range, hour, now)
  const approximate = report.total > 0 && reconstructed(db, range)
  const days = report.days.map((day) => toDay(day, approximate))

  const screen: HistoryScreen = {
    span: arg.span,
    from: range.from,
    to: range.to,
    emptyIndex: sourceCount(db) === 0,
    firstDay: report.firstDay,
    daysWithSpend: report.daysWithSpend,
    days,
    total: measured(report.total, approximate || report.approximate),
    coverage: coverage(report),
  }
  const selected = selectDay(report, arg.at)
  if (selected !== null) {
    screen.selected = summary(db, selected, config, report)
  }
  return screen
}

/**
 * Границы периода.
 *
 * «Неделя» — **календарная** неделя, в которой лежит сегодня, а не семь
 * последних суток. Так нарисовано в макете («3 — 9 августа» при сегодняшнем
 * восьмом), и разница не косметическая: у календарной недели есть дни в
 * будущем, и ровно на них видно третий вид пустоты — «данных нет» против
 * «работы не было». Скользящее окно кончалось бы сегодня, и завтрашнего
 * столбика не существовало бы вовсе.
 *
 * Неделя начинается с понедельника независимо от локали: расположение выходных
 * — это про вид календаря, а здесь оно означает «конец рабочей недели справа»,
 * и переезд субботы в начало сломал бы чтение хитмапа, а не оформление.
 *
 * «30 дней» — скользящее окно от сегодня назад: у него календарной рамки нет,
 * и притворяться месяцем оно не должно.
 */
function spanRange(
  db: Db,
  span: HistorySpan,
  hour: number,
  now: number,
): { from: number; to: number } {
  const today = dayRange(now, hour)
  if (span === 'all') {
    const first = db.get<{ first: number | null }>('SELECT min(ts) AS first FROM requests')?.first
    return { from: first == null ? today.from : dayRange(first, hour).from, to: today.to }
  }
  if (span === 'month') {
    return { from: dayRange(now, hour, 1 - SPAN_DAYS.month).from, to: today.to }
  }
  // `getDay()` даёт 0 у воскресенья — оно последнее, а не первое.
  const weekday = (new Date(today.from).getDay() + 6) % 7
  return {
    from: dayRange(now, hour, -weekday).from,
    to: dayRange(now, hour, SPAN_DAYS.week - weekday).from,
  }
}

function toDay(day: HistoryReport['days'][number], approximate: boolean): HistoryDay {
  return {
    at: day.at,
    // Две неточности спорят за один знак, и сильнее та, у которой не измерена
    // даже погрешность: восстановленное (1.3) промахивается на ≤ 3.3%, а за
    // удалённым логом может стоять что угодно.
    tokens: dayTokens(day, approximate),
    byProvider: day.byProvider,
    hours: day.hours,
  }
}

function dayTokens(day: HistoryReport['days'][number], approximate: boolean): Measured | null {
  if (day.tokens === null) return null
  if (day.approximate) return lowerBound(day.tokens)
  return measured(day.tokens, approximate)
}

/**
 * «6 дней с данными · 9 августа данных нет».
 *
 * Суждение, поэтому собирается здесь (правило 3.0): пустой столбик значит
 * разное — «работы не было» и «этих суток мы не видели», — и объяснить, какой
 * именно пуст, может только тот, кто знает почему. Названа **первая** такая
 * дата: перечислять их все значит писать в подписи ещё одну гистограмму.
 */
function coverage(report: HistoryReport): string {
  const withData = report.days.filter((day) => day.tokens !== null).length
  const missing = report.days.find((day) => day.tokens === null)
  const covered = t('history.covered', { count: withData })
  if (missing === undefined) return covered
  return `${covered} · ${t('history.missing', {
    date: new Date(missing.at).toLocaleDateString(locale(), { day: 'numeric', month: 'long' }),
  })}`
}

/**
 * Какой день раскрыт справа.
 *
 * Запрошенный — если он в периоде и данные за него есть; иначе последний день
 * с расходом. Не «последний день периода»: он может быть завтрашним по
 * отношению к последнему запуску, и правая колонка показала бы нули там, где
 * верно «данных нет».
 */
function selectDay(report: HistoryReport, at: number | undefined): number | null {
  if (at !== undefined) {
    const asked = report.days.find((day) => day.at === at && day.tokens !== null)
    if (asked !== undefined) return asked.at
  }
  const withSpend = report.days.filter((day) => (day.tokens ?? 0) > 0)
  return withSpend.at(-1)?.at ?? null
}

function summary(
  db: Db,
  at: number,
  config: Config,
  report: HistoryReport,
): HistoryDaySummary {
  const range = dayRange(at, config.ui.dayStartsAtHour)
  const day = todayReport(db, range)
  const totals = day.totals
  const total = totals?.total ?? 0
  const share = (value: number): number => (total === 0 ? 0 : value / total)
  const exact = (value: number): Measured => ({ value, confidence: 'exact' })
  const tokens: TokenSlice[] = [
    { kind: 'input', tokens: exact(totals?.input ?? 0), share: share(totals?.input ?? 0) },
    {
      kind: 'cacheWrite',
      tokens: exact(totals?.cacheWrite ?? 0),
      share: share(totals?.cacheWrite ?? 0),
    },
    {
      kind: 'cacheRead',
      tokens: measured(totals?.cacheRead ?? 0, day.approximate),
      share: share(totals?.cacheRead ?? 0),
    },
    { kind: 'output', tokens: exact(totals?.output ?? 0), share: share(totals?.output ?? 0) },
  ]

  // Итог суток, у которых не достаёт лога, — нижняя граница. Куски по видам
  // токенов и по провайдерам при этом остаются измеренными: пропал лог Claude,
  // а не байты Codex, и объявлять оценкой то, что прочитано, — враньё в другую
  // сторону.
  const vanished = report.days.find((row) => row.at === at)?.approximate === true

  const result: HistoryDaySummary = {
    at,
    total: vanished ? lowerBound(total) : measured(total, day.approximate),
    sessions: day.sessions ?? 0,
    tasks: day.tasks ?? 0,
    requests: totals?.requests ?? 0,
    tokens,
    providers: day.providers.map((row) => ({
      provider: row.key as Provider,
      tokens: measured(row.totals.total, day.approximate),
      share: share(row.totals.total),
    })),
    projects: projects(day.projects, day.approximate),
    ...toSpendSplit(spendSplit(db, range), day.approximate),
  }
  const median = splitMedian(db, report, config.ui.dayStartsAtHour)
  if (median !== null) result.splitMedian = median
  // Число задач берётся из той же сборки, что лента: `todayReport.tasks`
  // считает сессии, а задача — это дерево с сабагентами внутри (3.5), и в
  // клодовые дни разница доходит до трети.
  result.tasks = taskRows(db, range).length
  return result
}

/**
 * Медиана доли постоянного по дням с расходом — «медиана за 116 дней — 30.4%».
 *
 * Считается по всем дням индекса, а не по показанному периоду: смысл строки в
 * том, чтобы сравнить сегодняшнюю долю с обычной для этого человека, а неделя
 * — слишком короткая линейка для слова «обычно». `null`, когда сравнивать не с
 * чем: на одном дне медиана равна ему самому и говорит «сегодня как сегодня».
 */
function splitMedian(db: Db, report: HistoryReport, hour: number): number | null {
  if (report.daysWithSpend < 2 || report.firstDay === null || report.lastDay === null) return null
  const shares: number[] = []
  for (let at = report.firstDay; at <= report.lastDay; at = dayRange(at, hour, 1).from) {
    const split = spendSplit(db, dayRange(at, hour))
    if (split.total > 0) shares.push(split.recurring / split.total)
  }
  if (shares.length < 2) return null
  shares.sort((left, right) => left - right)
  return shares[Math.floor(shares.length / 2)] ?? null
}

/** Проекты дня со свёрнутым хвостом — те же правила, что в «Сегодня». */
function projects(
  rows: ReturnType<typeof todayReport>['projects'],
  approximate: boolean,
): ProjectRow[] {
  const head = rows.slice(0, KEEP_PROJECTS).map(
    (row): ProjectRow => ({
      project: row.key,
      tokens: measured(row.totals.total, approximate),
      provider: null,
    }),
  )
  const tail = rows.slice(KEEP_PROJECTS)
  if (tail.length === 0) return head
  return [
    ...head,
    {
      project: '',
      tokens: measured(
        tail.reduce((sum, row) => sum + row.totals.total, 0),
        approximate,
      ),
      provider: null,
      folded: tail.length,
    },
  ]
}

function reconstructed(db: Db, range: { from: number; to: number }): boolean {
  return (
    db.get<{ one: number }>(
      `SELECT 1 AS one FROM requests
       WHERE requests.origin = 'reconstructed' AND requests.ts >= ? AND requests.ts < ?
       LIMIT 1`,
      range.from,
      range.to,
    ) !== undefined
  )
}
