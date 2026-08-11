import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudePrompt, codexPrompt, PROMPT_CHARS } from '../../src/live/prompt.ts'
import { turnTokens } from '../../src/live/rate.ts'
import { createLiveLayer } from '../../src/live/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

/**
 * Текущий ход агента — этап 6.1.
 *
 * Проверки названы по поломке, которую ловят. Замеры, на которых стоят правила,
 * лежат в шапке `live/prompt.ts`: 18 997 результатов инструмента против 1 331
 * реплики человека, 79 расхождений `last-prompt` с текстом записи `user` и все
 * в пользу первой.
 */

/** Строки хвоста так, как они лежат в файле: по записи на строку. */
function lines(...records: unknown[]): string[] {
  return records.map((record) => JSON.stringify(record))
}

const prompt = (text: string, ts = '2026-08-10T08:00:00.000Z') => ({
  type: 'user',
  timestamp: ts,
  promptId: 'p1',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

const toolResult = (ts = '2026-08-10T08:05:00.000Z') => ({
  type: 'user',
  timestamp: ts,
  promptId: 'p1',
  toolUseResult: { stdout: 'x' },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
})

const lastPrompt = (text: string) => ({ type: 'last-prompt', lastPrompt: text, leafUuid: 'u' })

const codexUser = (message: string, ts = '2026-08-10T08:00:00.000Z') => ({
  type: 'event_msg',
  ts,
  payload: { type: 'user_message', message },
})

describe('текущий запрос — Claude', () => {
  /**
   * Ловит «берём последнюю запись `user`». Результат инструмента записан тем же
   * типом, и на живых логах их в четырнадцать раз больше, чем реплик человека:
   * строка ленты показывала бы вывод `Bash` вместо вопроса, почти всегда.
   */
  it('не принимает результат инструмента за реплику человека', () => {
    const read = claudePrompt(lines(prompt('почини тесты'), lastPrompt('почини тесты'), toolResult()))
    expect(read?.text).toBe('почини тесты')
    expect(read?.at).toBe(Date.parse('2026-08-10T08:00:00.000Z'))
  })

  /**
   * Ловит подмену источника текста. В записи `user` слэш-команда лежит уже
   * развёрнутой CLI, и человек увидел бы под своей задачей `<command-message>`
   * вместо того, что набрал.
   */
  it('берёт текст из last-prompt, а не из развёрнутой реплики', () => {
    const expanded = '<command-message>jira</command-message> <command-name>/jira</command-name>'
    const read = claudePrompt(lines(prompt(expanded), lastPrompt('/jira сделай задачу')))
    expect(read?.text).toBe('/jira сделай задачу')
  })

  /**
   * Ловит потерю отсева сайдчейна и служебных вставок. Реплика сабагента и
   * напоминание системы записаны тем же типом, и началом хода человека они не
   * являются: 263 такие записи на диске.
   */
  it('не считает началом хода сабагента и вставку системы', () => {
    const tail = lines(
      prompt('настоящий вопрос'),
      lastPrompt('настоящий вопрос'),
      { ...prompt('я сабагент', '2026-08-10T08:09:00.000Z'), isSidechain: true },
      { ...prompt('напоминание', '2026-08-10T08:10:00.000Z'), isMeta: true },
    )
    expect(claudePrompt(tail)?.at).toBe(Date.parse('2026-08-10T08:00:00.000Z'))
  })

  /**
   * Ловит слипание половин от разных ходов. Текст и метка читаются из разных
   * записей, и «первая найденная любая» дала бы вопрос одного хода с началом
   * другого — расход при этом посчитался бы от чужой границы.
   */
  it('берёт обе половины от последнего хода', () => {
    const tail = lines(
      prompt('старый вопрос', '2026-08-10T07:00:00.000Z'),
      lastPrompt('старый вопрос'),
      prompt('новый вопрос', '2026-08-10T09:00:00.000Z'),
      lastPrompt('новый вопрос'),
    )
    const read = claudePrompt(tail)
    expect(read?.text).toBe('новый вопрос')
    expect(read?.at).toBe(Date.parse('2026-08-10T09:00:00.000Z'))
  })

  /**
   * Ловит отправку в канал всего, что человек вставил. Промпт бывает и на сорок
   * килобайт — вставленным логом, — а снимок уезжает в окно раз в секунду.
   */
  it('обрезает длинный запрос и помечает обрезку', () => {
    const text = 'я'.repeat(PROMPT_CHARS + 50)
    const read = claudePrompt(lines(lastPrompt(text)))
    expect(read?.text).toHaveLength(PROMPT_CHARS + 1)
    expect(read?.text?.endsWith('…')).toBe(true)
  })

  /** Перенос внутри вопроса склеивал бы слова: «сделай\nдва» без разделителя. */
  it('схлопывает переносы строк в пробел', () => {
    expect(claudePrompt(lines(lastPrompt('сделай\nдва дела')))?.text).toBe('сделай два дела')
  })

  /** Пустой хвост — не «ход без вопроса», а «мы ничего не прочитали». */
  it('молчит, когда в куске нет ни одной половины', () => {
    expect(claudePrompt(lines({ type: 'assistant', message: { stop_reason: 'end_turn' } }))).toBe(
      undefined,
    )
  })
})

describe('текущий запрос — Codex', () => {
  /** У Codex обе половины в одной записи, и размечает её сам провайдер. */
  it('берёт текст и начало хода из user_message', () => {
    const read = codexPrompt(lines(codexUser('перепиши парсер'), { type: 'response_item' }))
    expect(read?.text).toBe('перепиши парсер')
    expect(read?.at).toBe(Date.parse('2026-08-10T08:00:00.000Z'))
  })

  /** Правила Claude на Codex не переносятся: свой формат — свой разбор. */
  it('берёт последнюю реплику, а не первую', () => {
    const read = codexPrompt(
      lines(codexUser('первый'), codexUser('второй', '2026-08-10T09:00:00.000Z')),
    )
    expect(read?.text).toBe('второй')
  })
})

describe('расход текущего хода', () => {
  let tmp: string
  let db: Db

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-turn-'))
    db = openDb(join(tmp, 'index.sqlite')).db
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function session(id: string, parent: string | null = null): void {
    db.run(
      `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
         parent_session_id)
       VALUES (?, 'claude', ?, '/proj', 'proj', 0, 0, ?)`,
      id,
      `/logs/${id}.jsonl`,
      parent,
    )
  }

  function request(id: string, seq: number, ts: number, tokens: number, origin = 'log'): void {
    db.run(
      `INSERT INTO requests (session_id, seq, request_id, ts, model, input, context_tokens, origin)
       VALUES (?, ?, ?, ?, 'claude-opus-5', ?, ?, ?)`,
      id,
      seq,
      `r${seq}`,
      ts,
      tokens,
      tokens,
      origin,
    )
  }

  /**
   * Ловит подмену расхода хода расходом сессии. Число стоит в строке рядом с
   * расходом за день, и «+87.3M за ход» под задачей на 87.3M — это не ошибка
   * округления, а другой ответ на другой вопрос.
   */
  it('считает от начала хода, а не от начала сессии', () => {
    session('s1')
    request('s1', 1, 1_000, 500)
    request('s1', 2, 3_000, 70)
    request('s1', 3, 4_000, 30)

    expect(turnTokens(db, new Map([['s1', 2_000]]), 9_000).get('s1')).toEqual({
      tokens: 100,
      requests: 2,
      reconstructed: 0,
    })
  })

  /**
   * Ловит потерю свёртки сабагентов: их расход родительский, и без свёртки ход,
   * в котором позвали трёх агентов, выглядел бы дешевле, чем он был.
   */
  it('сворачивает сабагента в родительский ход', () => {
    session('s1')
    session('sub', 's1')
    request('s1', 1, 3_000, 40)
    request('sub', 1, 3_500, 60)

    expect(turnTokens(db, new Map([['s1', 2_000]]), 9_000).get('s1')?.tokens).toBe(100)
  })

  /** Восстановленный запрос (1.3) внутри хода — повод для знака `≈`. */
  it('помечает ход с восстановленным запросом', () => {
    session('s1')
    request('s1', 1, 3_000, 40)
    request('s1', 2, 3_100, 60, 'gap')

    expect(turnTokens(db, new Map([['s1', 2_000]]), 9_000).get('s1')?.reconstructed).toBe(1)
  })
})

describe('текущий ход в снимке', () => {
  let tmp: string
  let db: Db

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-turn-live-'))
    db = openDb(join(tmp, 'index.sqlite')).db
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const SESSION = '11111111-2222-3333-4444-555555555555'

  /** Дом Claude с одним живым процессом — им притворяется сам тест. */
  function claudeHome(): string {
    const home = join(tmp, 'claude')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(
      join(home, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: SESSION,
        cwd: '/proj/live',
        startedAt: Date.now(),
        entrypoint: 'claude-vscode',
        version: '2.1.226',
      }),
    )
    mkdirSync(join(home, 'projects', '-proj-live'), { recursive: true })
    return home
  }

  /**
   * Записать хвост так, как его увидит следующий опрос.
   *
   * Половины хода лежат в разных записях, и в прочитанный кусок попадает то
   * одна, то обе: на живых логах `last-prompt` находится в последних 64 КБ у
   * 113 файлов из 120, а реплика человека — у 72. Уехавшая из окна запись здесь
   * изображается её отсутствием в файле — читается всегда весь.
   *
   * Метка времени файла двигается руками: два опроса подряд укладываются в одну
   * миллисекунду, а хвост перечитывается только при сдвинувшемся `mtime`.
   */
  let written = 0
  function writeTranscript(home: string, records: unknown[]): void {
    const path = join(home, 'projects', '-proj-live', `${SESSION}.jsonl`)
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    written += 1
    const stamp = new Date(Date.now() + written * 1000)
    utimesSync(path, stamp, stamp)
  }

  /**
   * Ловит «прочитали хвост — забыли, что знали». Реплика человека уезжает из
   * хвоста, как только агент допишет 64 КБ, а ход при этом продолжается:
   * вопрос под строкой моргал бы посреди работы.
   */
  it('помнит вопрос, уехавший из хвоста', () => {
    const home = claudeHome()
    writeTranscript(home, [prompt('почини тесты'), lastPrompt('почини тесты')])
    const live = createLiveLayer(db, { claudeHome: home, codexHome: join(tmp, 'нет') })
    expect(live.snapshot().agents[0]?.currentTurn?.prompt).toBe('почини тесты')

    // Тот же ход, но текста в прочитанном куске больше нет — только метка.
    writeTranscript(home, [prompt('почини тесты')])
    expect(live.snapshot().agents[0]?.currentTurn?.prompt).toBe('почини тесты')
  })

  /**
   * Ловит обратное: прилипший вопрос прошлого хода. Новая метка обязана забрать
   * с собой и текст, иначе расход нового хода подписан старым вопросом — и
   * отличить это на экране от правды нечем.
   */
  it('меняет вопрос вместе с ходом', () => {
    const home = claudeHome()
    writeTranscript(home, [prompt('первый'), lastPrompt('первый')])
    const live = createLiveLayer(db, { claudeHome: home, codexHome: join(tmp, 'нет') })
    live.snapshot()

    // Новый ход начался, а его текст в кусок не попал: старый показывать нельзя.
    writeTranscript(home, [prompt('второй', '2026-08-10T09:00:00.000Z')])
    const turn = live.snapshot().agents[0]?.currentTurn
    expect(turn?.startedAt).toBe(Date.parse('2026-08-10T09:00:00.000Z'))
    expect(turn?.prompt).toBe(undefined)
  })

  /**
   * Ловит зеркальную ошибку: новый вопрос приехал, а его метка — нет. Оставь мы
   * прежнюю, расход считался бы от границы прошлого хода — то есть был бы
   * завышен, и заметить это на экране нечем.
   */
  it('снимает метку, когда вопрос сменился без неё', () => {
    const home = claudeHome()
    writeTranscript(home, [prompt('первый'), lastPrompt('первый')])
    const live = createLiveLayer(db, { claudeHome: home, codexHome: join(tmp, 'нет') })
    live.snapshot()

    writeTranscript(home, [lastPrompt('второй')])
    const turn = live.snapshot().agents[0]?.currentTurn
    expect(turn?.prompt).toBe('второй')
    expect(turn?.startedAt).toBe(undefined)
    expect(turn?.spend).toBe(undefined)
  })

  /**
   * Ловит вопрос под строкой «завершился 2 мин назад»: он читался бы как «над
   * этим и работает», хотя процесса уже нет.
   */
  it('снимает ход с завершившегося агента', () => {
    const home = claudeHome()
    writeTranscript(home, [prompt('почини тесты'), lastPrompt('почини тесты')])
    const live = createLiveLayer(db, { claudeHome: home, codexHome: join(tmp, 'нет') })
    live.snapshot()

    rmSync(join(home, 'sessions', `${process.pid}.json`))
    const agent = live.snapshot().agents[0]
    expect(agent?.state).toBe('done')
    expect(agent?.currentTurn).toBe(undefined)
  })
})
