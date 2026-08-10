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
  calibration: {
    cacheReadWeight: number | null
    fiveHourCap: number | null
    weeklyCap: number | null
    plan: string | null
  }
}
