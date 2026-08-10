import type { LimitWindow, MarginalBasis, Provider } from '../sources/types.ts'

export interface DayRange {
  from: number
  to: number
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
  model: string
  title: string
  totals: Totals
  toolCalls: number
  subagents: number
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
