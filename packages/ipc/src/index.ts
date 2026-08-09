/**
 * Контракт между main и renderer.
 *
 * Всё общение идёт через две карты: `IpcCalls` — запрос-ответ, `IpcEvents` —
 * push из main. Канал, которого нет в карте, не существует: `ipcRenderer`
 * оборачивается типизированным клиентом, и строковых литералов в коде окна
 * быть не должно. Иначе через полгода никто не скажет, какие каналы живые.
 *
 * Правило про данные: в renderer уходят готовые к показу числа и признак
 * точности. Renderer не считает расход сам — иначе одна и та же цифра
 * окажется посчитанной дважды и разойдётся.
 */
import type { Entrypoint, LimitWindow, Provider } from '@agentmeter/core'

/** Агент, работающий прямо сейчас. */
export interface LiveAgent {
  sessionId: string
  provider: Provider
  project: string
  cwd: string
  branch?: string
  model?: string
  entrypoint: Entrypoint
  startedAt: number
  /** думает / ждёт ответа пользователя / простаивает / закончил */
  state: 'working' | 'waiting' | 'idle' | 'done'
  tokens: number
  /** Темп за последние минуты, токенов в минуту. */
  rate: number
  /** Заполнение контекстного окна, 0..1. Нет данных о размере окна — undefined. */
  contextFill?: number
}

/** Одна цифра с честной пометкой, откуда она взялась. */
export interface Measured {
  value: number
  /**
   * `exact` — прочитано из логов как есть. `reconstructed` — восстановлено
   * арифметикой, погрешность известна. `estimate` — оценка, показывать со
   * штриховкой и знаком ≈.
   */
  confidence: 'exact' | 'reconstructed' | 'estimate'
  /** Что именно не удалось измерить — текст для подсказки в интерфейсе. */
  caveat?: string
}

export interface DayTotals {
  input: Measured
  output: Measured
  cacheWrite: Measured
  cacheRead: Measured
  requests: number
  sessions: number
}

/** То, что показывает попап из трея. */
export interface TraySnapshot {
  agents: LiveAgent[]
  limits: LimitWindow[]
  today: DayTotals
  /** Ближайший к потолку лимит — по нему красится иконка в трее. */
  nearestLimitPercent?: number
  indexing?: IndexProgress
}

export interface IndexProgress {
  phase: 'idle' | 'scanning' | 'parsing' | 'done' | 'error'
  filesDone: number
  filesTotal: number
  message?: string
}

export interface TodayFilter {
  from: number
  to: number
  provider?: Provider
  project?: string
  /** Свернуть сабагентов в родительскую задачу. */
  foldSubagents?: boolean
}

export interface TaskRow {
  sessionId: string
  title: string
  project: string
  branch?: string
  provider: Provider
  model?: string
  startedAt: number
  endedAt: number
  tokens: Measured
  toolCalls: number
  /** Сабагенты, свёрнутые внутрь. */
  children?: TaskRow[]
}

export interface BreakdownRow {
  key: string
  label: string
  /** Что именно разложено: тулы, MCP-серверы, скиллы, сабагенты, категории. */
  axis: 'tool' | 'mcp' | 'skill' | 'agent' | 'category'
  /** Разовая стоимость: результаты вызовов, попавшие в промпт. */
  marginal: Measured
  /** Постоянная: то, что лежит в префиксе и перечитывается каждый запрос. */
  recurring: Measured
  calls: number
}

export interface DoctorReport {
  cliVersions: string[]
  unknownRecordTypes: Record<string, number>
  malformedLines: number
  /** Расхождение с эталоном Claude Code, если его удалось посчитать. */
  verify?: { checked: number; exact: number; worstPercent: number }
  problems: string[]
}

/**
 * Запрос-ответ. Ключ — имя канала, `arg` — аргумент, `result` — ответ.
 * Всё сериализуемое структурным клонированием: ни функций, ни классов.
 */
export interface IpcCalls {
  'snapshot:get': { arg: void; result: TraySnapshot }
  'today:list': { arg: TodayFilter; result: TaskRow[] }
  'task:get': { arg: { sessionId: string }; result: TaskRow | null }
  'breakdown:get': {
    arg: { scope: 'day' | 'session'; sessionId?: string; from?: number; to?: number }
    result: BreakdownRow[]
  }
  'limits:get': { arg: void; result: LimitWindow[] }
  'config:get': { arg: void; result: { config: unknown; problems: string[] } }
  'config:set': { arg: { patch: unknown }; result: { problems: string[] } }
  'index:rebuild': { arg: void; result: void }
  'doctor:get': { arg: void; result: DoctorReport }
  'window:open': { arg: { tab: 'today' | 'breakdown' | 'history' | 'settings' }; result: void }
  'app:quit': { arg: void; result: void }
}

/** Push из main в renderer. Только уведомления, запрашивать данные обратно нельзя. */
export interface IpcEvents {
  'live:update': TraySnapshot
  'index:progress': IndexProgress
  'alert:limit': { provider: Provider; kind: LimitWindow['kind']; usedPercent: number }
  'alert:session': { sessionId: string; tokens: number; reason: 'idle' | 'expensive' | 'question' }
  'config:changed': { problems: string[] }
}

export type IpcCallName = keyof IpcCalls
export type IpcEventName = keyof IpcEvents

/** Имена каналов списком — для регистрации обработчиков без строк по коду. */
export const IPC_CALLS = [
  'snapshot:get',
  'today:list',
  'task:get',
  'breakdown:get',
  'limits:get',
  'config:get',
  'config:set',
  'index:rebuild',
  'doctor:get',
  'window:open',
  'app:quit',
] as const satisfies readonly IpcCallName[]

export const IPC_EVENTS = [
  'live:update',
  'index:progress',
  'alert:limit',
  'alert:session',
  'config:changed',
] as const satisfies readonly IpcEventName[]
