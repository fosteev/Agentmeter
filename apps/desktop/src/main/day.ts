/**
 * Агрегаты (1.10) → `DayReport` контракта 0.4. Вкладка «Сегодня», раздел 3
 * макета.
 *
 * Тот же довод, что у `snapshot.ts`: считается здесь и только здесь. Окно
 * получает готовые числа, доли, которые видно текстом, и фразы, внутри которых
 * есть цифра. Всё, что осталось окну, — масштабировать полоски под ширину.
 */
import {
  daySplits,
  hasRequests,
  taskRows,
  todayReport,
  type Db,
  type HourSplit,
  type ProjectSplit,
  type Provider,
  type RequestScope,
  type TaskRow as CoreTaskRow,
  type Totals,
} from '@agentmeter/core'
import { measured } from './measured.ts'
import type {
  DayReport,
  DayTotals,
  FoldedTail,
  HourBucket,
  Measured,
  ProjectRow,
  TaskRow,
  TodayFilter,
} from '@agentmeter/ipc'

/**
 * Ниже какой доли расхода задача уходит в хвост.
 *
 * Число живёт здесь, а не в конфиге: настройка была бы догадкой о потребности,
 * которую никто не высказывал. Доля, а не абсолютное значение, — потому что
 * лента одинаково нужна и на дне в 340M, и на дне в 3M, а «ниже 4M» на втором
 * свернуло бы всё.
 */
const FOLD_SHARE = 0.01
/** Сколько строк показываем всегда, даже если по порогу свернулось бы больше. */
const KEEP_ROWS = 5
/** Хвост из одной строки места не экономит — такой не сворачиваем вовсе. */
const MIN_FOLDED = 2
/** Сколько проектов показываем поимённо; остальные — строкой «+ N проектов». */
const KEEP_PROJECTS = 4

export function buildDayReport(db: Db, filter: TodayFilter): DayReport {
  const range = { from: filter.from, to: filter.to }
  const scope: RequestScope = {}
  if (filter.provider !== undefined) scope.provider = filter.provider
  if (filter.project !== undefined) scope.project = filter.project

  const report = todayReport(db, range, scope)
  const splits = daySplits(db, range, scope)
  const sort = filter.sort ?? 'tokens'
  const options = filter.foldSubagents === false ? { foldSubagents: false } : {}
  const tasks = sortTasks(taskRows(db, range, scope, options), sort).map((row) => toTaskRow(row))

  return {
    range,
    emptyIndex: report.emptyIndex,
    // Про день, а не про фильтр: `todayReport.emptyDay` считает уже суженный
    // итог, и при `provider: codex` в чисто клодовый день он сказал бы «день
    // пустой». Это другой экран и другие слова.
    emptyDay: !hasRequests(db, range),
    totals: toDayTotals(report.totals, report.approximate, report.sessions, report.projects.length),
    tasks,
    folded: foldTail(tasks, sort),
    byHour: splits.hours.map(toHourBucket),
    byProject: toProjectRows(splits.projects),
    // `split` (постоянное против разового) не заполняется: модель постоянной
    // стоимости сводится в дневной итог в 4.1. Нули здесь были бы утверждением
    // «на префикс ушло ноль», и оно ложное.
  }
}

function sortTasks(rows: readonly CoreTaskRow[], sort: NonNullable<TodayFilter['sort']>) {
  const key = (row: CoreTaskRow): number =>
    sort === 'tokens' ? row.totals.total : sort === 'requests' ? row.totals.requests : row.startedAt
  // Второй ключ — идентификатор сессии: без него две задачи с равным расходом
  // меняются местами от запроса к запросу, и строка под курсором уезжает.
  return [...rows].sort(
    (left, right) => key(right) - key(left) || left.sessionId.localeCompare(right.sessionId),
  )
}

/**
 * Строка ленты из строки ядра. Экспортируется потому, что карточка задачи
 * (`task.ts`) обязана показывать в шапке **ту же** строку, что свёрнутая лента
 * над ней: собери её вторым похожим кодом — и однажды они разойдутся полем,
 * которое видно на экране дважды.
 */
export function toTaskRow(row: CoreTaskRow): TaskRow {
  const task: TaskRow = {
    sessionId: row.sessionId,
    title: row.title,
    project: row.project,
    provider: row.provider,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    requests: row.totals.requests,
    toolCalls: row.toolCalls,
    tokens: measured(row.totals.total, row.approximate),
  }
  if (row.firstPrompt !== null) task.firstPrompt = row.firstPrompt
  if (row.branch !== null) task.branch = row.branch
  if (row.model.length > 0) task.model = row.model
  if (row.agentType !== null) task.agentType = row.agentType
  // Тем же переводом, что и родитель: строка ребёнка показывается в карточке
  // рядом с его расходом, и собери её вторым похожим кодом — однажды они
  // разойдутся полем, которое видно на экране дважды.
  if (row.children.length > 0) task.children = row.children.map((child) => toTaskRow(child))
  return task
}

/**
 * Где обрывается видимая часть ленты.
 *
 * Порог считается от расхода **за период**, а не от самой дорогой задачи: доля
 * от лидера свернула бы половину ленты в день с одной большой задачей и не
 * свернула бы ничего в ровный день.
 *
 * Сортировка — не отдельная проверка снаружи, а вход правила: «ниже 4M» на
 * ленте, упорядоченной по времени, означало бы дыры посреди списка, и это часть
 * того же решения, а не соседнее условие в вызывающем коде.
 */
export function foldTail(
  tasks: readonly TaskRow[],
  sort: NonNullable<TodayFilter['sort']>,
): FoldedTail | null {
  if (sort !== 'tokens') return null
  const total = tasks.reduce((sum, task) => sum + task.tokens.value, 0)
  if (total === 0) return null
  const belowTokens = Math.round(total * FOLD_SHARE)
  const first = tasks.findIndex((task) => task.tokens.value < belowTokens)
  if (first === -1) return null
  const from = Math.max(first, KEEP_ROWS)
  if (tasks.length - from < MIN_FOLDED) return null
  return { from, belowTokens }
}

function toHourBucket(hour: HourSplit): HourBucket {
  return {
    hour: hour.hour,
    slices: hour.slices.map((slice) => ({ provider: slice.provider, tokens: slice.total })),
    total: hour.total,
  }
}

/**
 * Проекты поимённо плюс хвост одной строкой.
 *
 * Сумма хвоста считается здесь: сложить её в окне значит посчитать тот же
 * расход второй раз, и разойтись эти два счёта могут молча — например если
 * окно сложит только показанные строки.
 */
function toProjectRows(projects: readonly ProjectSplit[]): ProjectRow[] {
  const head = projects.slice(0, KEEP_PROJECTS).map((project): ProjectRow => ({
    project: project.project,
    tokens: measured(project.total, project.reconstructed > 0),
    provider: dominant(project),
  }))
  const tail = projects.slice(KEEP_PROJECTS)
  if (tail.length === 0) return head
  const total = tail.reduce((sum, project) => sum + project.total, 0)
  const reconstructed = tail.some((project) => project.reconstructed > 0)
  return [
    ...head,
    {
      project: '',
      tokens: measured(total, reconstructed),
      // У хвоста провайдера нет по построению: там смесь, и красить её в чей-то
      // цвет значит приписать расход не тому.
      provider: null,
      folded: tail.length,
    },
  ]
}

/**
 * Чей это проект. `null` — поровну: приписать проект одному провайдеру при
 * равных суммах значит выбрать цвет монеткой.
 */
function dominant(project: ProjectSplit): Provider | null {
  const [first, second] = project.slices
  if (first === undefined) return null
  if (second !== undefined && second.total === first.total) return null
  return first.provider
}

/**
 * Тот же перевод точности, что в `snapshot.ts`: восстановленное (1.3) — всегда
 * `cache_read`, а сумма наследует худшую из четырёх, потому что содержит его
 * внутри себя.
 */
function toDayTotals(
  totals: Totals | null,
  approximate: boolean,
  sessions: number | null,
  projects: number,
): DayTotals {
  const exact = (value: number): Measured => ({ value, confidence: 'exact' })
  return {
    input: exact(totals?.input ?? 0),
    output: exact(totals?.output ?? 0),
    cacheWrite: exact(totals?.cacheWrite ?? 0),
    cacheRead: measured(totals?.cacheRead ?? 0, approximate),
    total: measured(totals?.total ?? 0, approximate),
    requests: totals?.requests ?? 0,
    sessions: sessions ?? 0,
    projects,
  }
}
