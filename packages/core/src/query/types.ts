import type { ModelSpeed } from './speed.ts'
import type { LimitWindow, MarginalBasis, Provider } from '../sources/types.ts'

export interface DayRange {
  from: number
  to: number
}

/**
 * Чем сужен запрос к агрегатам. Провайдер и проект живут вместе, потому что
 * сузить надо все три ответа сразу — итог, ленту и разрезы. Отфильтруй список
 * задач, забыв про итог, — и шапка покажет весь день над лентой из одного
 * проекта, а сумма строк не сойдётся с числом над ними.
 */
export interface RequestScope {
  provider?: Provider
  project?: string
}

export interface Totals {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
  requests: number
}

export interface TotalsRow {
  key: string
  totals: Totals
}

export interface TodayReport {
  range: DayRange
  emptyIndex: boolean
  emptyDay: boolean
  approximate: boolean
  totals: Totals | null
  tasks: number | null
  sessions: number | null
  providers: TotalsRow[]
  models: TotalsRow[]
  projects: TotalsRow[]
  hours: Array<TotalsRow & { hour: number }>
}

export interface TaskRow {
  sessionId: string
  provider: Provider
  startedAt: number
  endedAt: number
  durationMs: number
  project: string
  branch: string | null
  /**
   * Ключ тикета из имени ветки (3.7). `null` — в имени его нет.
   *
   * Лежит рядом с веткой, а не выводится из неё на месте показа: правило
   * извлечения — измерение с посчитанной долей ложных срабатываний, и второй
   * его экземпляр в рендерере разошёлся бы с первым молча.
   */
  ticket: string | null
  model: string
  /**
   * Название, которое дал агент. `null` — его нет.
   *
   * Подстановка «без названия» жила здесь до 3.1 и была удобной ровно до
   * первого экрана: макет рисует безымянную задачу иначе — тире, серый текст и
   * первый промпт подписью (строки 649–651). Схлопнутая строка делает два вида
   * строки неразличимыми по данным, а различать их больше негде.
   */
  title: string | null
  /** Первый промпт сессии. Подпись у безымянной задачи, запасное имя в CLI. */
  firstPrompt: string | null
  /**
   * Каким сабагентом запущена сессия (`Explore`, `Plan`). `null` — это не
   * сабагент. Имени у такой сессии больше нет: `title` у всех девяти детей на
   * живых логах пуст, и назвать строку в списке нечем.
   */
  agentType: string | null
  totals: Totals
  toolCalls: number
  /**
   * Сабагенты, свёрнутые внутрь этой строки (3.5). Пусто — детей нет либо
   * запрошен режим `foldSubagents: false`, где каждая сессия сама себе строка.
   *
   * Список **плоский**: сабагент может породить сабагента, и вложенность
   * показала бы один и тот же расход на двух уровнях. Отдельного счётчика рядом
   * нет специально — два поля с одним числом расходятся молча.
   */
  children: TaskRow[]
  approximate: boolean
  sidechain: boolean
}

export interface ToolBreakdownRow {
  key: string
  calls: Record<MarginalBasis, number>
  tokens: Record<MarginalBasis, number>
}

export interface TokenBreakdownRow {
  key: string
  calls: number
  tokens: number
}

/**
 * Клетка «проект × модель» (8.1) — сумма запросов одной пары ключей.
 *
 * Тип свой, а не шестая ось в плоском `TotalsRow`: клетке нужны два ключа, и
 * единственный способ впихнуть её в одноключевую строку — склеить их текстом.
 * После склейки по разрезу нельзя ни отсортировать по проекту, ни сузить по
 * модели, ни перевести подпись — ключ перестаёт быть ключом.
 */
export interface MatrixCell {
  /** Как написано в логе: `claude-opus-5`, `gpt-5.6-sol`. */
  model: string
  provider: Provider
  totals: Totals
  /**
   * Сколько токенов клетки пришло восстановленными запросами (1.3).
   *
   * Токены у них измерены, а модель — нет: в логе её нет вовсе, она взята у
   * соседа ([`claude/parse.ts`](../sources/claude/parse.ts)). Отсюда правило
   * показа: `≈` стоит на строке модели и **не** стоит на итоге проекта —
   * пометить итог значит объявить неточным единственное точное число строки.
   *
   * Токенами, а не долей: знаменатель у экрана и у CLI разный, и доля,
   * посчитанная в ядре, была бы долей от чужого целого.
   */
  inherited: number
  /**
   * Скорость модели за период (8.4) — только у маргинали `SpendMatrix.models`,
   * и только у модели с измеренными запросами не ниже `SPEED.minRequests`.
   * У клетки проекта её нет: выборка клетки в разы меньше, и порог отсёк бы
   * половину таблицы.
   */
  speed?: ModelSpeed
}

/** Строка таблицы проектов: итог проекта и его клетки по убыванию расхода. */
export interface MatrixRow {
  /**
   * Ключ, а не подпись: им же сужается запрос (`RequestScope.project`). Пустая
   * строка — законное значение, имя словами даёт `projectRowLabel`.
   */
  project: string
  totals: Totals
  cells: MatrixCell[]
}

export interface SpendMatrix {
  /** По убыванию расхода, без исключений — даже ради показательной строки. */
  rows: MatrixRow[]
  /**
   * Маргиналь по моделям за период — те же клетки, сложенные поперёк.
   *
   * Список не обязан быть коротким: на длинном периоде моделей тринадцать, с
   * хвостом в один-два запроса. Где резать хвост — решает экран, а не ядро.
   */
  models: MatrixCell[]
  /**
   * Итог периода, посчитанный **отдельным запросом**, а не сложением клеток.
   * В этом и смысл: сумма клеток, сложенная из клеток, сойдётся с собой при
   * любой ошибке в группировке.
   */
  totals: Totals
  emptyIndex: boolean
  /**
   * После сужения не осталось ни одного запроса.
   *
   * Это не «за период не работали»: третье состояние считается `hasRequests`
   * **до** сужения (правило 15). Выведи одно из другого по пустому списку — и
   * человек, оставивший фильтр на Codex в клодовый день, прочтёт «за неделю
   * ничего», глядя на полную неделю.
   */
  emptyScope: boolean
}

export interface BreakdownReport {
  emptyIndex: boolean
  emptyScope: boolean
  totals: Totals | null
  tool: ToolBreakdownRow[]
  server: TokenBreakdownRow[]
  skill: TotalsRow[]
  agent: TotalsRow[]
  model: TotalsRow[]
}

/**
 * Прогноз «когда упрёмся» — вторая половина 2.3.
 *
 * Это оценка и ничем иным быть не может: она продлевает в будущее темп
 * последних минут. Помечается как оценка везде, где показывается.
 */
export interface LimitForecast {
  /** Наш замер расхода за хвостовое окно, токенов в минуту. */
  tokensPerMinute: number
  /**
   * Через сколько минут расход упрётся в потолок. `null` — темп нулевой,
   * упираться нечем.
   */
  minutesToCap: number | null
  /** Окно сбросится раньше, чем кончится лимит. Тогда упор не наступит. */
  resetsFirst: boolean
}

export interface LimitReportRow extends LimitWindow {
  unavailableReason: string | null
  /** `null` — процент окна неизвестен, продлевать нечего. */
  forecast: LimitForecast | null
}

export interface LimitsReport {
  emptyIndex: boolean
  at: number
  windows: LimitReportRow[]
}

export interface DiagnosticRow {
  kind: string
  detail: string
  count: number
  cliVersion: string | null
}

export interface DoctorReport {
  emptyIndex: boolean
  indexPath: string
  schemaVersion: number
  sources: number
  sessions: number | null
  requests: number | null
  diagnostics: DiagnosticRow[]
  parserErrors: number
  reconstructedSessions: number
  /**
   * Источники, которых не стало на диске. Их сессии остались в индексе, и с
   * этого момента он единственная запись о том расходе — Claude Code чистит
   * свои транскрипты сам. Ноль здесь — не «всё хорошо», а «пока не чистил».
   */
  vanishedSources: number
  calibration: {
    cacheReadWeight: number | null
    fiveHourCap: number | null
    weeklyCap: number | null
  }
}
