import type { Entrypoint, Provider } from '../sources/types.ts'

/**
 * Что агент делает прямо сейчас.
 *
 * В 2.1 различаются только `working` и `idle`, и по одному грубому правилу —
 * была ли активность в пределах порога тишины. `waiting` (агент спросил и ждёт
 * человека) и `done` (процесс жив, но работа кончилась) требуют разбора хвоста
 * транскрипта и появляются в 2.2. Поле заведено сразу, чтобы контракт IPC (0.4)
 * не пришлось менять из-за этапа.
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
  /** Тип последней записи транскрипта. Сырая строка источника — вход для 2.2. */
  lastEventKind?: string
  state: LiveState
  /** Расход сессии вместе со свёрнутыми в неё сабагентами. */
  tokens: number
  requests: number
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
