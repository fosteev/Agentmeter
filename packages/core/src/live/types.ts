import type { Entrypoint, Provider } from '../sources/types.ts'
import type { TurnKind } from './state.ts'

/**
 * Что агент делает прямо сейчас (2.2).
 *
 * `working` — думает или ждёт свой инструмент: ход у агента, и в логе движение.
 * `waiting` — ход у человека: модель закончила ответ либо спросила. Тишина тут
 * ничего не меняет — ждать человека можно и три часа.
 * `idle` — ход у агента, но в логе тишина дольше порога. Честное «не вижу
 * работы»: так выглядят зависший инструмент, запрос разрешения и уснувший
 * процесс, и выдавать это за «думает» нельзя.
 * `done` — процесса больше нет. Строка держится в снимке `doneGraceMs` и
 * гаснет, как в макете.
 *
 * Правила вывода — [`state.ts`](./state.ts).
 */
export type LiveState = 'working' | 'waiting' | 'idle' | 'done'

export interface LiveAgent {
  sessionId: string
  provider: Provider
  /** У Codex реестра процессов нет — там всегда `null`. */
  pid: number | null
  project: string
  cwd: string
  branch?: string
  model?: string
  entrypoint: Entrypoint
  cliVersion?: string
  /** Имя, которым процесс представился. */
  name?: string
  startedAt: number
  /** Последнее движение в транскрипте: запись хвоста, иначе `mtime` файла. */
  lastActivityAt: number
  /**
   * Момент последнего **записанного запроса** из индекса. Не то же, что
   * `lastActivityAt`: между запросами в лог сыплются результаты вызовов и
   * реплики человека. Замер 1.3 считает от этого поля, и подмена его
   * активностью даёт ноль на каждой сессии.
   */
  lastRequestTs?: number
  /**
   * Вид последней записи транскрипта: `type` у Claude, `payload.type` у Codex.
   * Сырая строка источника — она чаще всего учётная и состояния не задаёт,
   * держится для `doctor` и разбора расхождений.
   */
  lastEventKind?: string
  /** Чей ход по хвосту лога. `undefined` — в прочитанный кусок не попало. */
  turn?: TurnKind
  /** Инструмент, результата которого ждёт агент. */
  pendingTool?: string
  state: LiveState
  /** Когда процесса не стало. Только у `state: 'done'`. */
  endedAt?: number
  /** Расход сессии вместе со свёрнутыми в неё сабагентами. */
  tokens: number
  requests: number
  /**
   * Темп за хвостовое окно, токенов в минуту (2.3). Ноль — сессия моложе пола
   * усреднения либо в окне не было запросов. Единица та же, что у `tokens`.
   */
  rate: number
  /** Есть восстановленные запросы — число показывается со знаком `≈`. */
  approximate: boolean
  /**
   * Жив ли процесс достоверно. У Claude это факт (pid проверен), у Codex —
   * догадка по свежести роллаута, и врать про её природу нельзя.
   */
  liveness: 'process' | 'silence'
}

export interface LiveSnapshot {
  at: number
  agents: LiveAgent[]
  /** Чего мы не поняли в файлах живых сессий — вход для `doctor`. */
  warnings: string[]
}

/**
 * Наблюдение за жизнью процесса — долг 1.3.
 *
 * Хвостовые прогревы после последнего ответа следа в логах не оставляют, и их
 * число зависит от того, сколько процесс прожил после него. Лог этого не
 * пишет; живой слой видит. Искомая величина — `endedAt − lastRequestTs`.
 */
export interface SessionLifetime {
  sessionId: string
  provider: Provider
  pid: number | null
  /** Старт процесса из файла сессии. */
  startedAt: number
  /** Когда живой слой увидел сессию впервые. */
  firstSeenAt: number
  /** Последний опрос, на котором процесс был ещё жив. */
  lastSeenAt: number
  /**
   * Первый опрос, на котором процесса уже не было. `null` — смерть не
   * наблюдалась: приложение выключили, машина уснула. Догадываться нельзя,
   * иначе замер подменяется выдумкой.
   */
  endedAt: number | null
  /** Последний записанный запрос сессии на момент наблюдения. */
  lastRequestTs: number | null
  cliVersion?: string
}
