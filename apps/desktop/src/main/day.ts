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
  spendSplit,
  t,
  taskRows,
  todayReport,
  type Db,
  type SpendSplitReport,
  type HourSplit,
  type ProjectSplit,
  type Provider,
  type Config,
  type RequestScope,
  type TaskRow as CoreTaskRow,
  type TicketSplit,
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
  SpendSplit,
  TaskRow,
  TicketRow,
  TodayFilter,
} from '@agentmeter/ipc'

/**
 * Настройки приватности, доехавшие до сборки экрана (3.6).
 *
 * Отдельным маленьким типом, а не целым `Config`: сборщику ленты нужны ровно
 * два флага, и передача всего конфига открыла бы ему потолки лимитов и пути к
 * логам — то есть дала бы возможность считать что-нибудь ещё. Тумблер,
 * который ничего не меняет в данных, был бы враньём на экране настроек.
 */
export type Privacy = Pick<Config['privacy'], 'hidePrompts' | 'hidePaths'>

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

export function buildDayReport(
  db: Db,
  filter: TodayFilter,
  privacy?: Privacy,
  live?: LiveOrder,
): DayReport {
  const range = { from: filter.from, to: filter.to }
  const scope: RequestScope = {}
  if (filter.provider !== undefined) scope.provider = filter.provider
  if (filter.project !== undefined) scope.project = filter.project

  const report = todayReport(db, range, scope)
  const splits = daySplits(db, range, scope)
  const sort = filter.sort ?? 'tokens'
  const options = filter.foldSubagents === false ? { foldSubagents: false } : {}
  const tasks = pinLive(
    sortTasks(taskRows(db, range, scope, options), sort).map((row) => toTaskRow(row, privacy, live)),
    live,
  )

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
    // Поля нет вовсе, когда тикетов не нашлось: пустой блок обещал бы разрез,
    // которого за этот день не существует (3.7).
    ...(splits.tickets.length === 0 ? {} : { byTicket: toTicketRows(splits.tickets) }),
    // Поля нет, пока за период нет расхода: «на префикс ушло ноль» — это
    // утверждение, и оно ложное там, где верно «ничего не было» (4.1).
    ...toSpendSplit(spendSplit(db, range, scope), report.approximate),
  }
}

/**
 * «Куда ушло сегодня»: постоянное против разового (4.1, строки 806–817).
 *
 * Доли считаются здесь, потому что их видно числом («41%») — правило 3.0.
 * Ширина полосы под ними в окне берётся из тех же долей, и второго счёта там
 * нет: полоса и подпись обязаны показывать одно и то же число.
 *
 * Округление долей — на разовом, а не на постоянном: сумма процентов обязана
 * давать сто, а «постоянный» — та величина, вокруг которой строится вывод, и
 * подгонять надо не её. При нулевом итоге долей не существует вовсе, и блока
 * нет: ноль процентов — это ответ, которого мы не давали.
 */
export function toSpendSplit(
  split: SpendSplitReport,
  approximate: boolean,
): { split: SpendSplit } | Record<string, never> {
  if (split.total === 0) return {}
  const share = split.recurring / split.total
  return {
    split: {
      slices: [
        { kind: 'recurring', tokens: measured(split.recurring, approximate), share },
        { kind: 'marginal', tokens: measured(split.marginal, approximate), share: 1 - share },
      ],
      note: spendNote(share),
    },
  }
}

/**
 * Вывод под полосой: какая из трёх фраз верна при такой доле.
 *
 * Экспортируется затем же, зачем `foldTail`, — границы полос это решение, а не
 * оформление, и проверяются они по границам, а не по тому, что случайно выпало
 * на фикстурах: доля ниже четверти на них не встречается вовсе.
 *
 * Фраз три, а не одна с подстановкой доли: каждая обязана быть правдой во всей
 * своей полосе. «Почти половина» из макета верна на 41% и уже неправда на 26%,
 * а полосу обслуживает одну и ту же — поэтому взята самая слабая из верных.
 */
export function spendNote(share: number): string {
  if (share >= 0.5) return t('split.noteHigh')
  return share >= 0.25 ? t('split.noteMedium') : t('split.noteLow')
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
 * Живые сессии на момент сборки: идентификатор → срочность (`LIVE_URGENCY`).
 *
 * Не просто список: закреплённые строки упорядочены **той же** таблицей, что
 * список в попапе, — работающие, ждущие ответа, молчащие. Один и тот же список
 * на двух экранах обязан быть упорядочен одинаково.
 */
export type LiveOrder = ReadonlyMap<string, number>

/**
 * Живые задачи — в начало ленты (6.1).
 *
 * Закрепление нужно не ради важности, а ради видимости: при сортировке по
 * расходу работающая минуту назад сессия стоит внизу списка, а то и в
 * свёрнутом хвосте, и «что происходит сейчас» ответа на экране не имеет.
 *
 * Внутри закреплённых порядок — по срочности, дальше по выбранной сортировке:
 * `sort` устойчив, и равные по срочности остаются там, где их поставил
 * выбранный ключ. Незакреплённые не двигаются вовсе.
 *
 * Выбранную сортировку это переопределяет, и молчать об этом нельзя: подпись
 * над лентой говорит «сначала активные», пока закреплённые строки есть.
 */
export function pinLive(tasks: readonly TaskRow[], live?: LiveOrder): TaskRow[] {
  const pinned = tasks.filter((task) => task.live === true)
  const rank = (task: TaskRow): number => live?.get(task.sessionId) ?? 0
  return [
    ...pinned.sort((left, right) => rank(left) - rank(right)),
    ...tasks.filter((task) => task.live !== true),
  ]
}

/**
 * Строка ленты из строки ядра. Экспортируется потому, что карточка задачи
 * (`task.ts`) обязана показывать в шапке **ту же** строку, что свёрнутая лента
 * над ней: собери её вторым похожим кодом — и однажды они разойдутся полем,
 * которое видно на экране дважды.
 */
export function toTaskRow(row: CoreTaskRow, privacy?: Privacy, live?: LiveOrder): TaskRow {
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
  // «Скрыть тексты промптов» (3.6): поля просто нет, и безымянная задача
  // остаётся безымянной. Пустая строка вместо него была бы промптом нулевой
  // длины — то есть данными, которых не было.
  if (row.firstPrompt !== null && privacy?.hidePrompts !== true) task.firstPrompt = row.firstPrompt
  if (row.branch !== null) task.branch = row.branch
  if (row.ticket !== null) task.ticket = row.ticket
  if (row.model.length > 0) task.model = row.model
  if (row.agentType !== null) task.agentType = row.agentType
  if (live?.has(row.sessionId) === true) task.live = true
  // Тем же переводом, что и родитель: строка ребёнка показывается в карточке
  // рядом с его расходом, и собери её вторым похожим кодом — однажды они
  // разойдутся полем, которое видно на экране дважды.
  //
  // Живость детям не передаётся и не ищется: своего процесса у сабагента нет,
  // а его расход уже свёрнут в родителя — вторая пульсирующая точка внутри
  // карточки означала бы второго работающего агента, которого не существует.
  if (row.children.length > 0) task.children = row.children.map((child) => toTaskRow(child, privacy))
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
 *
 * Живые строки хвост не забирает никогда (6.1): сессия, начатая минуту назад,
 * дешевле порога по построению — расходу просто неоткуда взяться, — и общее
 * правило свернуло бы ровно то, ради чего в ленту сейчас и смотрят.
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
  const live = tasks.filter((task) => task.live === true).length
  const from = Math.max(first, KEEP_ROWS, live)
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
 * Тикеты поимённо плюс хвост одной строкой — тем же правилом, что проекты.
 *
 * Хвост считается здесь по той же причине: сложи его окно — и тот же расход
 * окажется посчитан дважды, причём разойтись счёты могут молча.
 */
function toTicketRows(tickets: readonly TicketSplit[]): TicketRow[] {
  const head = tickets.slice(0, KEEP_PROJECTS).map(
    (ticket): TicketRow => ({
      ticket: ticket.ticket,
      tokens: measured(ticket.total, ticket.reconstructed > 0),
      provider: dominant(ticket),
    }),
  )
  const tail = tickets.slice(KEEP_PROJECTS)
  if (tail.length === 0) return head
  const total = tail.reduce((sum, ticket) => sum + ticket.total, 0)
  return [
    ...head,
    {
      ticket: '',
      tokens: measured(total, tail.some((ticket) => ticket.reconstructed > 0)),
      provider: null,
      folded: tail.length,
    },
  ]
}

/**
 * Чей это проект. `null` — поровну: приписать проект одному провайдеру при
 * равных суммах значит выбрать цвет монеткой.
 */
function dominant(project: ProjectSplit | TicketSplit): Provider | null {
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
