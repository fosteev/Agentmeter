/**
 * Текущий запрос: над чем агент работает прямо сейчас — этап 6.1.
 *
 * В макете этого нет, как темпа (2.3) и указателя контекста (2.6). Вопрос, ради
 * которого лента открывается при работающем агенте, звучит «а что он сейчас
 * делает» — и ответом на него служит не название сессии (оно про всю сессию), а
 * последняя реплика человека. Отсюда два числа рядом с ней: сколько ушло **с
 * начала этого хода** и с какой скоростью уходит.
 *
 * Разбор здесь тот же, что у состояния (2.2): назад по хвосту до первой
 * значимой записи, без чтения файла целиком. Что показали живые логи (272
 * транскрипта Claude, 348 роллаутов Codex):
 *
 * — **Результат инструмента у Claude — тоже запись `user`.** Их 18 997 против
 *   1 331 человеческой реплики, и делит их поле `toolUseResult` без единого
 *   исключения. Брать «последнюю запись `user`» значит показать в строке ленты
 *   вывод `Bash` вместо вопроса человека — то есть почти всегда.
 *
 * — **Текст берётся только из `last-prompt`.** Эту запись пишет сам CLI, и она
 *   хранит то, что человек **набрал**. Сверка на 260 файлах: 180 совпали с
 *   текстом человеческой записи, 79 разошлись — и во всех расхождениях права
 *   `last-prompt`. В самой записи `user` слэш-команда лежит уже развёрнутой
 *   (`<command-message>pilot-jira</command-message>…` вместо
 *   «/pilot-jira …сделай задачу в этот эпик»), прерывание записано служебным
 *   «[Request interrupted by user]», а переносы строк не схлопнуты. Тот же
 *   источник у первого промпта в индексе (`sources/claude/parse.ts`), так что
 *   строка ленты и живая подпись под ней не могут разойтись видом.
 *
 * — **Метка времени есть только у записи `user`.** У `last-prompt` полей всего
 *   четыре (`type`, `lastPrompt`, `leafUuid`, `sessionId`), времени среди них
 *   нет, а `leafUuid` указывает не на реплику человека (совпал с её `uuid` в 5
 *   случаях из 70). Поэтому текст читается из одной записи, начало хода — из
 *   другой, и каждая отвечает за то, что в ней действительно записано.
 *
 * — **У Codex обе половины в одной записи.** `user_message` несёт и текст, и
 *   метку; служебных среди них нет вовсе — ни одной с `<environment_context>`
 *   или `<user_instructions>` на 648 записях.
 */
import type { Provider } from '../sources/types.ts'

/**
 * Что прочитано о текущем ходе. Обе половины необязательны и приезжают из
 * разных записей: в прочитанный кусок могла попасть одна из них.
 */
export interface PromptRead {
  /** Начало хода — метка записи, которой человек передал слово агенту. */
  at?: number
  /** Текст запроса, уже подготовленный к показу. */
  text?: string
}

/**
 * Потолок длины текста.
 *
 * Не оформление, а защита канала: снимок уезжает в окно раз в секунду, а
 * промпт бывает и на сорок килобайт — вставленным логом, куском файла. Обрезка
 * помечается многоточием, потому что обрезанный текст без пометки читается как
 * весь.
 */
export const PROMPT_CHARS = 200

export function readPrompt(provider: Provider, lines: readonly string[]): PromptRead | undefined {
  return provider === 'codex' ? codexPrompt(lines) : claudePrompt(lines)
}

/**
 * Хвост Claude: текст из `last-prompt`, начало хода из реплики человека.
 *
 * Просмотр идёт назад и останавливается, когда найдены обе половины. Ранний
 * выход по одной только первой был бы ошибкой: `last-prompt` пишется **после**
 * реплики, то есть встречается раньше при обратном ходе, и разбор бросил бы
 * поиск метки времени, не начав его.
 */
export function claudePrompt(lines: readonly string[]): PromptRead | undefined {
  const out: PromptRead = {}
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parseLine(lines[i])
    if (record === undefined) continue
    const type = record['type']

    if (type === 'last-prompt') {
      if (out.text === undefined) {
        const text = clip(record['lastPrompt'])
        if (text !== undefined) out.text = text
        if (out.at !== undefined && out.text !== undefined) break
      }
      continue
    }

    if (type !== 'user' || out.at !== undefined) continue
    // Результат инструмента, вставка системы и реплика сабагента ход человеку
    // не передают. Первое — 19 146 записей на диске, и все они без текста
    // вовсе, то есть отсекаются и проверкой содержимого ниже; `toolUseResult`
    // стоит раньше неё как признак, которым результат помечает сам провайдер,
    // и заодно избавляет глубокий дочит от обхода содержимого девятнадцати
    // тысяч записей.
    if ('toolUseResult' in record) continue
    if (record['isMeta'] === true || record['isSidechain'] === true) continue
    if (humanText(record) === undefined) continue
    const at = timestampOf(record)
    if (at !== undefined) out.at = at
    if (out.at !== undefined && out.text !== undefined) break
  }
  return out.at === undefined && out.text === undefined ? undefined : out
}

/** Хвост Codex: `user_message` несёт и текст, и метку времени. */
export function codexPrompt(lines: readonly string[]): PromptRead | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parseLine(lines[i])
    if (record === undefined) continue
    const payload = asObject(record['payload'])
    if (payload?.['type'] !== 'user_message') continue
    const out: PromptRead = {}
    const at = timestampOf(record)
    if (at !== undefined) out.at = at
    const text = clip(payload['message'])
    if (text !== undefined) out.text = text
    return out.at === undefined && out.text === undefined ? undefined : out
  }
  return undefined
}

/**
 * Есть ли в реплике человеческий текст.
 *
 * Проверка нужна только затем, чтобы не принять за начало хода запись, где
 * лежит одна картинка без слов, — таких на диске 2. Сам текст отсюда не
 * берётся: у Claude он уже развёрнут CLI, и правда о набранном лежит в
 * `last-prompt`.
 */
function humanText(record: Record<string, unknown>): string | undefined {
  const content = asObject(record['message'])?.['content']
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const item = asObject(block)
    if (item?.['type'] !== 'text') continue
    if (typeof item['text'] === 'string') parts.push(item['text'])
  }
  const text = parts.join('\n').trim()
  return text || undefined
}

/**
 * Текст к показу: пробельные последовательности схлопнуты, длина обрезана.
 *
 * Схлопывание — не косметика: промпт живёт в одной строке ленты, а перенос
 * внутри значения превращается в пробел молча, и «сделай\nдва дела» осталось бы
 * без разделителя вовсе.
 */
function clip(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  return text.length <= PROMPT_CHARS ? text : `${text.slice(0, PROMPT_CHARS)}…`
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
