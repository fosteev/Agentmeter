import { describe, expect, it } from 'vitest'
import { claudeTurn, codexTurn, deriveState } from '../../src/live/state.ts'

/** Строки хвоста так, как они лежат в файле: по записи на строку. */
function lines(...records: unknown[]): string[] {
  return records.map((record) => JSON.stringify(record))
}

const assistant = (stop: string | null, content: unknown[] = [{ type: 'text', text: 'x' }]) => ({
  type: 'assistant',
  timestamp: '2026-08-10T08:00:00.000Z',
  message: { role: 'assistant', stop_reason: stop, content },
})

const toolResult = () => ({
  type: 'user',
  timestamp: '2026-08-10T08:00:01.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
})

const codexEvent = (payloadType: string) => ({
  type: 'event_msg',
  ts: '2026-08-10T08:00:00.000Z',
  payload: { type: payloadType },
})

describe('чей ход — Claude', () => {
  /**
   * Ловит возврат к правилу 2.1 «берём тип последней записи». После значимой
   * записи в лог ложатся учётные — на живой машине их 20 тысяч против 44 тысяч
   * значимых, — и последней в файле оказывается именно учётная. Состояние по
   * ней было бы «не знаю» на каждой второй сессии.
   */
  it('не путает учётные записи со значимыми', () => {
    const tail = lines(
      assistant('end_turn'),
      { type: 'file-history-snapshot', messageId: 'm' },
      { type: 'last-prompt', lastPrompt: 'привет' },
      { type: 'ai-title', title: 't' },
    )
    expect(claudeTurn(tail)?.kind).toBe('turn-end')
  })

  /**
   * Ловит «ход у модели» на законченном ходе — то есть «думает» вместо «ждёт
   * ответа». Ровно эта ошибка делает трей бесполезным: агент стоит и ждёт
   * человека, а иконка говорит, что всё идёт.
   */
  it('конец хода — ход у человека', () => {
    expect(claudeTurn(lines(toolResult(), assistant('end_turn')))?.kind).toBe('turn-end')
    // `stop_sequence` на диске значит ровно одно: запись сочинил сам CLI, а не
    // модель («Credit balance is too low», «No response requested.»). Все 17
    // таких записей помечены `model: "<synthetic>"`, и других синтетических
    // записей нет. Модель тут не отвечала — значит ход у человека, и ему же
    // разбираться с причиной.
    expect(claudeTurn(lines(assistant('stop_sequence')))?.kind).toBe('turn-end')
  })

  it('вызов инструмента — ход у агента, с именем инструмента', () => {
    const tail = lines(
      assistant('tool_use', [{ type: 'text', text: 'сейчас' }]),
      assistant('tool_use', [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]),
    )
    const turn = claudeTurn(tail)
    expect(turn?.kind).toBe('tool-pending')
    expect(turn?.tool).toBe('Bash')
  })

  /**
   * Ловит «спросил и ждёт» под видом «думает». По времени эти два случая не
   * различимы: у `AskUserQuestion` медиана ожидания 50 с и максимум 15 часов,
   * то есть любой таймаут либо режет живых, либо пропускает ждущих.
   */
  it('вопрос человеку — ход у человека, хотя ход не закончен', () => {
    const tail = lines(
      assistant('tool_use', [{ type: 'tool_use', id: 'a', name: 'AskUserQuestion', input: {} }]),
    )
    const turn = claudeTurn(tail)
    expect(turn?.kind).toBe('ask-pending')
    expect(turn?.tool).toBe('AskUserQuestion')
  })

  /**
   * Ловит подмену родителя сабагентом: `end_turn` сайдчейна означает, что
   * закончил он, а родитель в этот момент как раз ждёт его результата. Без
   * проверки запущенный сабагент показывал бы родителя ждущим человека — то
   * есть звал бы к машине, у которой всё идёт своим ходом.
   */
  it('сайдчейн не подменяет ход родителя', () => {
    const tail = lines(
      assistant('tool_use', [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }]),
      { ...assistant('end_turn'), isSidechain: true },
    )
    expect(claudeTurn(tail)?.kind).toBe('tool-pending')
  })

  /**
   * Ловит служебные вставки, оформленные как реплика пользователя: 263 записи
   * на диске. Каждая такая после конца хода переворачивала бы «ждёт ответа» в
   * «думает» — и ровно в момент, когда человека надо позвать.
   */
  it('служебная реплика не передаёт ход', () => {
    const tail = lines(assistant('end_turn'), {
      type: 'user',
      isMeta: true,
      timestamp: '2026-08-10T08:00:02.000Z',
      message: { role: 'user', content: 'напоминание' },
    })
    expect(claudeTurn(tail)?.kind).toBe('turn-end')
  })

  /**
   * Ловит «недописанная строка стриминга = конец хода». `stop_reason` пуст у 73
   * записей из 27 402: ответ в этот момент пишется, а не закончен.
   */
  it('пустой stop_reason — ответ пишется прямо сейчас', () => {
    expect(claudeTurn(lines(assistant(null)))?.kind).toBe('agent-thinking')
  })

  it('в хвост не попало значимой записи — молчит, а не выдумывает', () => {
    expect(claudeTurn(lines({ type: 'attachment' }))).toBeUndefined()
    expect(claudeTurn(['{обрезано посередине'])).toBeUndefined()
  })
})

describe('чей ход — Codex', () => {
  it('task_complete — ход у человека, task_started — у модели', () => {
    expect(codexTurn(lines(codexEvent('task_complete')))?.kind).toBe('turn-end')
    expect(codexTurn(lines(codexEvent('task_started')))?.kind).toBe('agent-thinking')
    // Прерванный ход — тоже слово человеку: 99 записей на диске.
    expect(codexTurn(lines(codexEvent('turn_aborted')))?.kind).toBe('turn-end')
  })

  /**
   * Ловит просмотр назад, доезжающий до прошлого хода: в середине длинного хода
   * ближайший `task_complete` лежит **позади** его начала, и без остановки на
   * `task_started` работающий агент показывался бы ждущим.
   */
  it('середина хода не дочитывается до конца предыдущего', () => {
    const tail = lines(
      codexEvent('task_complete'),
      codexEvent('user_message'),
      codexEvent('task_started'),
      codexEvent('agent_reasoning'),
      codexEvent('exec_command_end'),
      codexEvent('token_count'),
    )
    expect(codexTurn(tail)?.kind).toBe('agent-thinking')
  })

  /**
   * Ловит перенос правил Claude на Codex: `response_item` с ролью assistant
   * лежит в роллауте на каждый ответ модели, но конца хода не означает — за ним
   * идёт `task_complete` либо следующий инструмент.
   */
  it('ответ модели сам по себе ход не заканчивает', () => {
    const tail = lines(
      codexEvent('task_started'),
      { type: 'response_item', ts: '2026-08-10T08:00:00.000Z', payload: { type: 'message', role: 'assistant' } },
    )
    expect(codexTurn(tail)?.kind).toBe('agent-thinking')
  })
})

describe('состояние из хода и тишины', () => {
  const base = { at: 1_000_000, idleMs: 90_000, alive: true }

  /**
   * Ловит «ждёт ответа → простой по таймауту». Агент, закончивший ход, ждёт
   * человека и через минуту, и через три часа: гасить эту строку значит
   * прятать единственный случай, ради которого в трей и смотрят.
   */
  it('ожидание человека не протухает от тишины', () => {
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 3 * 3_600_000, turn: 'turn-end' })).toBe(
      'waiting',
    )
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 3 * 3_600_000, turn: 'ask-pending' })).toBe(
      'waiting',
    )
  })

  /**
   * Ловит «думает» на зависшем инструменте и уснувшем процессе: ход у агента,
   * но в логе тишина, и утверждать, что он думает, нечем.
   */
  it('ход у агента плюс тишина дольше порога — молчит', () => {
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 30_000, turn: 'tool-pending' })).toBe(
      'working',
    )
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 200_000, turn: 'tool-pending' })).toBe(
      'idle',
    )
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 200_000, turn: 'agent-thinking' })).toBe(
      'idle',
    )
  })

  it('нечитаемый хвост откатывается к правилу 2.1', () => {
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 10_000 })).toBe('working')
    expect(deriveState({ ...base, lastActivityAt: 1_000_000 - 200_000 })).toBe('idle')
  })

  it('мёртвый процесс перебивает любой ход', () => {
    expect(
      deriveState({ ...base, alive: false, lastActivityAt: 1_000_000, turn: 'agent-thinking' }),
    ).toBe('done')
  })
})
