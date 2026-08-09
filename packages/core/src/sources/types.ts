/**
 * Нормализованная модель — общий знаменатель Claude Code и Codex.
 *
 * Контракт этапа 0.2. Всё, что стоит выше (индекс, атрибуция, лимиты, запросы
 * под экраны), работает только с этими типами и не знает, из какого формата их
 * достали. Менять их можно, но осознанно и в одном месте — не «дописать поле,
 * раз парсеру понадобилось».
 *
 * Соглашения:
 * - все метки времени — epoch ms в UTC (в логах ISO-строки, приводим при разборе);
 * - все счётчики токенов — сырые числа из `usage`, без домножения на коэффициенты
 *   стоимости или веса лимита; веса живут в конфиге и применяются выше;
 * - поле, которого в источнике нет, опускается, а не заполняется нулём — ноль
 *   означает «источник сказал ноль», `undefined` — «источник промолчал».
 */

export type Provider = 'claude' | 'codex'

/** Откуда взялась цифра в `marginalTokens`. */
export type MarginalBasis =
  | 'measured' // единственный вызов запроса, дельта целиком
  | 'split' // доля дельты, поделённой между параллельными вызовами
  | 'unknown' // дельта неизмерима: компакт, хвост сессии, перебивка

/** Откуда запущен агент. `unknown` — живой сессии на диске не нашлось. */
export type Entrypoint = 'cli' | 'vscode' | 'jetbrains' | 'desktop' | 'sdk' | 'exec' | 'unknown'

/**
 * Одна сессия агента — один файл лога.
 *
 * Внимание: сессия не равна задаче. `resume` и `--continue` порождают новые
 * файлы для той же работы, а сайдчейны сабагентов лежат отдельными файлами со
 * своими id. Склейка в задачу — этап 3.5, здесь только то, что лежит на диске.
 */
export interface Session {
  id: string
  provider: Provider
  /** Абсолютный путь к файлу лога — ключ для инкрементального дочитывания. */
  sourcePath: string

  cwd: string
  /** Человеческое имя проекта: последний сегмент `cwd`, а не slug каталога логов. */
  project: string
  branch?: string
  /** Первая модель сессии. Модель конкретного запроса — в `Request.model`. */
  model?: string
  entrypoint?: Entrypoint
  /** Версия CLI, которым писан лог. Нужна `doctor` при дрейфе формата. */
  cliVersion?: string

  /** Готовое название из `ai-title`, если Claude Code успел его сочинить. */
  title?: string
  /** Текст исходного промпта — запасное название, когда `title` нет. */
  firstPrompt?: string

  startedAt: number
  endedAt: number

  /**
   * Для транскрипта сабагента — id родительской сессии. Сабагенты лежат в
   * `projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`, рядом
   * `.meta.json` с `agentType` и `toolUseId` вызова, породившего сабагента.
   */
  parentSessionId?: string
  /** `toolUseId` вызова `Agent` в родителе — связь без догадок. */
  parentToolUseId?: string
  /** Имя сабагента из `.meta.json`: `Explore`, `Plan`, свои из `.claude/agents`. */
  agentType?: string
  /** Все запросы сессии — сайдчейновые. Признак файла-сабагента. */
  isSidechain?: boolean
}

/**
 * Один вызов API — одна оплаченная единица работы.
 *
 * В транскрипте Claude один вызов размазан по нескольким строкам `assistant`
 * (по строке на блок контента) с общим `requestId`. Здесь он уже собран в одну
 * запись — суммировать `Request[]` можно и нужно. Схлопывать надо максимумом
 * по каждому полю: `output_tokens` в ранних строках частичный, стриминг
 * дописывает его по ходу ответа.
 */
export interface Request {
  sessionId: string
  /** Порядковый номер внутри сессии, с нуля. Соседство важно для атрибуции. */
  seq: number
  /** `requestId` источника. Не уникален построчно в логе, уникален здесь. */
  requestId: string
  ts: number
  model: string

  /**
   * `log` — запись есть в транскрипте. `reconstructed` — запроса в логе нет,
   * он восстановлен по разрыву цепочки кэша (`cr(N+1) > cr(N) + cw(N)`).
   * Восстановленные — служебные прогревы между ходами; их стоимость известна
   * точно, а вот `ts`, `model` и `requestId` у них выведены, а не прочитаны.
   * Всё, что показывается пользователем как точная цифра, должно уметь
   * объяснить эту разницу — см. 1.3.
   */
  origin: 'log' | 'reconstructed'

  /** Свежий ввод, не покрытый кэшем. */
  input: number
  output: number
  /** Записано в кэш на этом запросе — то есть добавлено в промпт с прошлого раза. */
  cacheWrite: number
  /** Прочитано из кэша — префикс, за который платим на каждом запросе. */
  cacheRead: number
  /** Рассуждение. Codex отдаёт явно, Claude включает в `output`. */
  reasoning?: number

  /** Разбивка `cacheWrite` по TTL — для расчёта переплаты за паузы (D9). */
  cacheWrite5m?: number
  cacheWrite1h?: number

  /** Занято контекстного окна на этом запросе: `input + cacheRead + cacheWrite`. */
  contextTokens: number
  /** Размер окна модели, если источник его сообщает (Codex — да). */
  contextWindow?: number

  /** Прямая разметка из `attributionSkill` — расход привязан к скиллу без арифметики. */
  skill?: string
  /** Запрос сабагента, а не основной ветки. */
  isSidechain: boolean
  /** Префикс скакнул вниз — контекст сжали. Ломает соседство для атрибуции. */
  compacted: boolean
  /**
   * Служебный вызов, а не пользовательский ход: генерация заголовка сессии и
   * прочая внутренняя работа CLI. В `lastModelUsage` такие идут отдельной
   * моделью (Haiku), в транскрипте их может не быть вовсе — см. 1.3.
   */
  synthetic: boolean

  /**
   * Байт текста, который пользователь дописал после этого запроса и до
   * следующего. Не ноль — значит, дельта кэша несёт не только результаты
   * тулов, и атрибутировать её нельзя.
   */
  interjectedBytes: number

  tools: ToolCall[]
}

export type ToolKind = 'builtin' | 'mcp' | 'skill' | 'agent' | 'web' | 'unknown'

export interface ToolCall {
  id: string
  name: string
  kind: ToolKind
  /** Для `mcp__<server>__<tool>` — имя сервера. */
  server?: string

  /**
   * Длина сериализованного результата в логе. Врёт как источник стоимости —
   * на реальном `Read` в лог легло 382 КБ, а в промпт ушло 2873 токена, — но
   * нужна как вес при дележе дельты между параллельными вызовами.
   */
  resultBytes: number
  /**
   * Сколько вызов реально добавил в промпт. Считается атрибуцией (1.6) из
   * дельты кэша, а не из размера результата. До неё — 0.
   */
  marginalTokens: number
  /** Чем эта цифра является: измерением, долей или признанием незнания. */
  marginalBasis: MarginalBasis
  /** Результат содержит картинку. У скриншотов base64 в лог не пишется вовсе. */
  hasImage: boolean
}

/**
 * Живая сессия: процесс, который прямо сейчас запущен.
 *
 * У Claude лежит в `~/.claude/sessions/<pid>.json` и переживает смерть
 * процесса — pid обязательно проверять на живость, иначе в трее навсегда
 * повиснут мёртвые агенты.
 */
export interface LiveSession {
  pid: number
  sessionId: string
  provider: Provider
  cwd: string
  startedAt: number
  entrypoint: Entrypoint
  cliVersion?: string
  /** Имя, которым процесс представился (`name` в файле сессии). */
  name?: string
}

/**
 * Окно лимита. У Codex приходит точным прямо в логе, у Claude считается
 * своей агрегацией и всегда помечается оценкой.
 */
export interface LimitWindow {
  provider: Provider
  /** `primary` у Codex — пятичасовое, `secondary` — недельное. */
  kind: 'primary' | 'secondary'
  usedPercent: number
  windowMinutes: number
  resetsAt?: number
  /** Цифра из лога провайдера, а не наш расчёт. */
  exact: boolean
}

/** Результат разбора одного файла лога. */
export interface ParseResult {
  session: Session
  requests: Request[]
  diagnostics: ParseDiagnostics
}

/**
 * Что парсер не понял. Пустой объект — норма; непустой едет в `doctor` (1.4).
 * Незнакомая запись никогда не роняет разбор, но и не замалчивается.
 */
export interface ParseDiagnostics {
  /** Типы записей, которых парсер не знает: `{ 'queue-operation': 12 }`. */
  unknownRecordTypes: Record<string, number>
  /** Строк, не разобравшихся как JSON. Обрыв на хвосте файла — обычное дело. */
  malformedLines: number
  /** Версии CLI, встреченные в файле. Больше одной — сессию продолжали после обновления. */
  cliVersions: string[]
}

/** Пустые диагностики — чтобы не собирать литерал в каждом парсере. */
export function emptyDiagnostics(): ParseDiagnostics {
  return { unknownRecordTypes: {}, malformedLines: 0, cliVersions: [] }
}
