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
import type { Entrypoint, LimitReportRow, LimitWindow, Provider } from '@agentmeter/core'

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
  /**
   * думает / ждёт ответа человека / молчит / завершился.
   *
   * Выводится в 2.2 из того, чем кончился транскрипт, а не из тишины:
   * `packages/core/src/live/state.ts`. `idle` — «ход у агента, но движения не
   * видно»; в макете такого состояния нет, точка у него контурная в `tx3`.
   */
  state: 'working' | 'waiting' | 'idle' | 'done'
  /**
   * Когда процесса не стало. Только у `state: 'done'`: строка держится в
   * снимке ещё несколько минут и гаснет, как в макете («завершился 2 мин
   * назад»).
   */
  endedAt?: number
  tokens: number
  /**
   * В расходе есть восстановленные запросы (1.3) — число показывается со
   * знаком `≈`. Без этого поля попап и CLI покажут на одной машине разные
   * числа без объяснения, какое из них точное.
   */
  approximate: boolean
  /** Темп за последние минуты, токенов в минуту. Ноль — темпа нет. */
  rate: number
  /**
   * Заполнение контекстного окна последним запросом (2.6).
   *
   * Здесь стояло голое `contextFill?: number`, и этого мало ровно по той же
   * причине, по которой не хватило голого `LimitWindow` в 2.5: доля без
   * происхождения — это оценка, выданная за факт. Числитель измерен у обоих
   * провайдеров, а знаменатель написал только Codex; у Claude размера окна нет
   * ни в логе, ни в имени модели, и он выводится из наблюдений. Разница между
   * этими двумя случаями — единственное, что окну надо показать.
   *
   * Поля нет вовсе, когда выводить не из чего. Пустое место честнее
   * правдоподобной доли.
   */
  context?: ContextUsage
}

/** Сколько окна занято и насколько мы уверены в его размере. */
export interface ContextUsage {
  /** Занято промптом последнего записанного запроса, токенов. */
  used: number
  /** Размер окна, токенов. */
  window: number
  /**
   * Доля занятого, 0..1. Лежит готовой: `used / window` в рендерере — это
   * третье число, выведенное из двух, и оно разойдётся с CLI на первой правке
   * округления.
   */
  fill: number
  /** `estimate` — размер окна не из лога, а выведен из наблюдавшегося максимума. */
  confidence: 'exact' | 'estimate'
  /** Чем именно оценка — текст для подсказки в интерфейсе. */
  caveat?: string
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
  /**
   * Сумма всех четырёх видов — то самое число в подвале попапа («344.9M»).
   *
   * Лежит здесь готовым не для удобства: сложить четыре поля в рендерере
   * значит посчитать расход второй раз и вывести из четырёх `confidence`
   * пятый — то есть завести в окне собственную арифметику точности, которая
   * разойдётся с CLI на первой же правке. Считает тот, кто считает всё
   * остальное.
   */
  total: Measured
  requests: number
  sessions: number
  /** Подвал попапа: «22 сессии · 8 проектов» (строка 449 макета). */
  projects: number
}

/** То, что показывает попап из трея. */
export interface TraySnapshot {
  /**
   * Момент снимка. Длительности («4 мин», «завершился 2 мин назад») считаются
   * от него, а не от часов рендерера: иначе тест на фикстуре краснеет по
   * календарю, а не по поломке, и «обновлено N с назад» врёт при задержке
   * доставки события.
   */
  at: number
  agents: LiveAgent[]
  /**
   * Окна лимита ровно в том виде, в каком их отдаёт `limitsReport` — с
   * причиной недоступности и прогнозом.
   *
   * Голый `LimitWindow` здесь стоял по недосмотру и терял оба поля, которые
   * попапу и нужны: без `unavailableReason` окно Claude без процента
   * показывать нечем, кроме пустой полосы, а это ровно та ошибка, ради
   * которой затевался продукт; без `forecast` пропадала вторая половина 2.3.
   */
  limits: LimitReportRow[]
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
  'limits:get': { arg: void; result: LimitReportRow[] }
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
