/**
 * Состояние агента: думает / ждёт ответа / молчит / завершился — этап 2.2.
 *
 * В 2.1 состояний было два и различались они по одному признаку — была ли
 * запись в логе за последние `idleMs`. Этого мало ровно в том случае, ради
 * которого затевался трей: агент, закончивший ход и ждущий человека, не пишет
 * ничего — и выглядит точно так же, как агент, который думает над длинным
 * ответом. Разница видна только в том, **чем именно кончился транскрипт**.
 *
 * Отсюда деление на два шага. Сначала из хвоста лога читается «чей ход»
 * (`TurnKind`) — это факт источника, без интерпретации. Потом из хода и тишины
 * выводится состояние. Первый шаг разный у провайдеров, второй общий.
 *
 * Что показали живые логи (590 транскриптов Claude, 346 роллаутов Codex):
 *
 * — **Тип последней записи не годится.** После значимой записи в лог сыплются
 *   учётные: `attachment`, `file-history-snapshot`, `last-prompt`, `mode`,
 *   `queue-operation`, `ai-title`, `permission-mode`, `system`. Их 20 тысяч
 *   против 44 тысяч значимых, и последней в файле оказывается именно учётная.
 *   Поэтому хвост просматривается назад до первой записи, меняющей владельца
 *   хода.
 *
 * — **Порядок записей в файле не хронологический.** Живой пример: запись
 *   `stop_hook_summary` с меткой 08:00:11 лежит **после** `queue-operation` с
 *   меткой 08:08:04. Сортировать по меткам нельзя, поэтому «последняя» — это
 *   последняя по положению в файле, а не по времени.
 *
 * — **У Codex ход размечен явно.** `task_started` / `task_complete` /
 *   `turn_aborted` — 909, 811 и 99 записей. Это лучший сигнал из существующих:
 *   его пишет сам провайдер, и гадать не приходится. Перенос правил Claude на
 *   Codex был бы чистой потерей точности.
 *
 * — **`stop_reason` бывает пустым** (73 записи из 27 402). Это недописанная
 *   строка стриминга: ответ в этот момент пишется, то есть ход у модели.
 *
 * — **`stop_sequence` у модели не встречается вовсе.** Все 17 таких записей на
 *   диске помечены `model: "<synthetic>"`: их сочинил сам CLI («Credit balance
 *   is too low», «No response requested.»), и других синтетических записей нет
 *   ни одной. Модель в этот момент не отвечала, разбираться с причиной
 *   человеку — то есть ход у него, и общее правило «не `tool_use` — значит
 *   конец хода» даёт здесь правильный ответ.
 */
import type { Provider } from '../sources/types.ts'
import type { LiveState } from './types.ts'

/**
 * Чей сейчас ход — прочитано из хвоста лога, без интерпретации.
 *
 * `agent-thinking` — ход у модели: в логе лежит результат инструмента или
 * реплика человека, ответа ещё нет.
 * `tool-pending` — модель вызвала инструмент, результата ещё нет. Ход тоже у
 * агента, но молчание здесь объясняется работой инструмента, а не моделью.
 * `ask-pending` — вызван инструмент, который **по устройству** ждёт человека
 * (`AskUserQuestion`, `ExitPlanMode`). Ход у человека, хотя ход не закончен.
 * `turn-end` — модель закончила ход. Ход у человека.
 */
export type TurnKind = 'agent-thinking' | 'tool-pending' | 'ask-pending' | 'turn-end'

export interface TurnRead {
  kind: TurnKind
  /** Метка времени записи, из которой прочитан ход. */
  at?: number
  /** Инструмент, ответа которого ждём. Только у `tool-pending` и `ask-pending`. */
  tool?: string
}

/**
 * Инструменты, которые останавливают агента до ответа человека.
 *
 * Не эвристика по времени: у `AskUserQuestion` медиана ожидания 50 с, а
 * максимум — 15 часов (51 вызов на диске), тогда как у `Edit` p95 = 1.1 с.
 * То есть отличить «спросил» от «долго работает» по таймауту нельзя, а по
 * имени инструмента — можно, и это факт устройства, а не подгонка.
 */
const ASKS_HUMAN = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * Записи Claude, которые не меняют владельца хода. Перечислены явно, а не
 * «всё, кроме assistant и user»: незнакомый тип должен останавливать разбор,
 * а не молча проскакивать. Дрейф формата ловится в 1.4, но состояние не должно
 * отвечать уверенно на записи, которой оно не понимает.
 */
const CLAUDE_BOOKKEEPING = new Set([
  'attachment',
  'file-history-snapshot',
  'file-history-delta',
  'last-prompt',
  'ai-title',
  'custom-title',
  'mode',
  'permission-mode',
  'queue-operation',
  'system',
  'summary',
])

/** Записи Codex, объявляющие конец хода: слово переходит человеку. */
const CODEX_TURN_END = new Set(['task_complete', 'turn_aborted', 'error'])

/** Записи Codex, объявляющие начало хода. */
const CODEX_TURN_START = new Set(['task_started', 'user_message'])

export function readTurn(provider: Provider, lines: readonly string[]): TurnRead | undefined {
  return provider === 'codex' ? codexTurn(lines) : claudeTurn(lines)
}

/**
 * Хвост транскрипта Claude, просмотренный назад до первой значимой записи.
 *
 * Пропускаются учётные записи (см. `CLAUDE_BOOKKEEPING`), сайдчейны и
 * служебные реплики (`isMeta`). Сайдчейн — это сабагент: его `end_turn`
 * означает, что закончил **он**, а родитель в этот момент как раз работает.
 * Без этой проверки запущенный сабагент показывал бы родителя ждущим.
 */
export function claudeTurn(lines: readonly string[]): TurnRead | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parseLine(lines[i])
    if (record === undefined) continue
    const type = record['type']
    if (typeof type !== 'string') continue
    if (CLAUDE_BOOKKEEPING.has(type)) continue
    if (record['isSidechain'] === true) continue

    const at = timestampOf(record)
    const message = asObject(record['message'])

    if (type === 'assistant') {
      const stop = message?.['stop_reason']
      // Пустой stop_reason — недописанная строка стриминга: ответ пишется
      // прямо сейчас, ход у модели.
      if (typeof stop !== 'string') return withAt({ kind: 'agent-thinking' }, at)
      if (stop !== 'tool_use') return withAt({ kind: 'turn-end' }, at)
      const tool = message === undefined ? undefined : pendingTool(message)
      const kind: TurnKind = tool !== undefined && ASKS_HUMAN.has(tool) ? 'ask-pending' : 'tool-pending'
      const read: TurnRead = { kind }
      if (tool !== undefined) read.tool = tool
      return withAt(read, at)
    }

    if (type === 'user') {
      // isMeta — вставка системы в виде реплики пользователя (напоминания,
      // подсказки). Ход она не передаёт: 263 такие записи на диске.
      if (record['isMeta'] === true) continue
      return withAt({ kind: 'agent-thinking' }, at)
    }
  }
  return undefined
}

/**
 * Хвост роллаута Codex. Ход размечен провайдером, гадать не нужно.
 *
 * Просмотр назад безопасен на границе хода: `task_started` пишется **первой**
 * записью хода, поэтому назад от любой его середины мы встретим её раньше, чем
 * `task_complete` предыдущего хода. Если в хвост не поместилось ни то ни
 * другое — возвращается `undefined`, и решает тишина. Соврать здесь нечем.
 */
export function codexTurn(lines: readonly string[]): TurnRead | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parseLine(lines[i])
    if (record === undefined) continue
    if (record['type'] !== 'event_msg') continue
    const payload = asObject(record['payload'])
    const kind = payload?.['type']
    if (typeof kind !== 'string') continue
    const at = timestampOf(record)
    if (CODEX_TURN_END.has(kind)) return withAt({ kind: 'turn-end' }, at)
    if (CODEX_TURN_START.has(kind)) return withAt({ kind: 'agent-thinking' }, at)
  }
  return undefined
}

export interface StateInput {
  at: number
  /** Последнее движение в логе — любая запись, включая учётные. */
  lastActivityAt: number
  idleMs: number
  /** Чей ход. `undefined` — хвост прочитать не удалось. */
  turn?: TurnKind | undefined
  /** Процесс жив (Claude) либо роллаут свеж (Codex). */
  alive: boolean
}

/**
 * Состояние из хода и тишины.
 *
 * Правило про `waiting` намеренно **не смотрит на тишину**: агент, закончивший
 * ход, ждёт человека и через минуту, и через три часа — это не «простой», а
 * ровно то, ради чего в трей смотрят. А вот «думает» с оговоркой: если ход у
 * агента, но в логе тишина дольше порога, честный ответ — «молчит», а не
 * «думает». Замер по живым логам: пауза между репликой человека и ответом
 * модели даёт p99 = 61.5 с при 16 317 наблюдениях, то есть порог 90 с
 * промахивается на 0.4% настоящих раздумий — и не выдаёт за раздумья
 * зависший инструмент, запрос разрешения и уснувший процесс.
 */
export function deriveState(input: StateInput): LiveState {
  if (!input.alive) return 'done'
  if (input.turn === 'turn-end' || input.turn === 'ask-pending') return 'waiting'
  return input.at - input.lastActivityAt <= input.idleMs ? 'working' : 'idle'
}

function withAt(read: TurnRead, at: number | undefined): TurnRead {
  if (at !== undefined) read.at = at
  return read
}

function parseLine(line: string | undefined): Record<string, unknown> | undefined {
  const trimmed = line?.trim()
  if (!trimmed) return undefined
  try {
    return asObject(JSON.parse(trimmed))
  } catch {
    // Первая строка куска почти всегда обрезана посередине — это норма.
    return undefined
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function timestampOf(record: Record<string, unknown>): number | undefined {
  const raw = record['timestamp'] ?? record['ts']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return undefined
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Имя инструмента, ответа которого ждём.
 *
 * Один ответ модели пишется несколькими строками (правило 3 в CLAUDE.md), и
 * `stop_reason: tool_use` стоит на каждой — включая ту, где лежит только текст.
 * Просмотр идёт назад, поэтому строка с самим вызовом встречается первой; если
 * её всё же нет, возвращается `undefined`, и вызов считается обычным.
 */
function pendingTool(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = asObject(content[i])
    if (block?.['type'] !== 'tool_use') continue
    const name = block['name']
    if (typeof name === 'string') return name
  }
  return undefined
}
