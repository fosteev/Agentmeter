/**
 * Разбор для экрана Workflow (9.1): `is_error` у вызова и голова последнего
 * ответа сабагента.
 *
 * Эталон на реальных строках и на руками написанном сабагенте — в
 * `fixtures/claude/sidechain.*` и `claude.test.ts`. Здесь каждая ловушка из
 * брифа лежит отдельным маленьким транскриптом, поэтому мутация называется
 * своим именем: «эмодзи на границе не рвётся пополам» читается как «срез по
 * единицам UTF-16», а не как «expected разошёлся».
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRolloutFile, parseSessionFile } from '../../src/index.ts'
import { parseSubagentFile } from '../../src/sources/claude/parse.ts'

const codexFixture = fileURLToPath(
  new URL('../../../../fixtures/codex/rollout.jsonl', import.meta.url),
)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-workflow-parse-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Json = Record<string, unknown>

function write(name: string, records: Json[]): string {
  const path = join(dir, name)
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

/** Одна строка ответа: один блок контента, как их пишет Claude Code. */
function assistant(
  requestId: string,
  timestamp: string,
  block: Json,
  options: { sidechain?: boolean } = {},
): Json {
  return {
    ...(options.sidechain === undefined ? {} : { isSidechain: options.sidechain }),
    type: 'assistant',
    requestId,
    timestamp,
    sessionId: 'workflow-session',
    cwd: '/proj/workflow',
    version: '2.1.226',
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      content: [block],
      usage: {
        input_tokens: 1,
        output_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function text(value: string): Json {
  return { type: 'text', text: value }
}

function toolUse(id: string): Json {
  return { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }
}

function toolResults(timestamp: string, blocks: Json[]): Json {
  return {
    type: 'user',
    timestamp,
    sessionId: 'workflow-session',
    cwd: '/proj/workflow',
    message: { role: 'user', content: blocks },
  }
}

describe('is_error у вызова', () => {
  /**
   * Ключа нет — `false`: в Messages API `is_error` по умолчанию ложен, и Claude
   * Code пишет явный `false` только у `Bash` (правило 30). «Не знаем» — только
   * ключ не того типа: `Boolean(...)` сделал бы ошибкой строку, а `false`
   * выдал бы мусор за ответ.
   */
  it.each([
    ['true', { is_error: true }, true],
    ['false', { is_error: false }, false],
    ['ключа нет', {}, false],
    ['null', { is_error: null }, undefined],
    ['строка «true»', { is_error: 'true' }, undefined],
    ['число 1', { is_error: 1 }, undefined],
  ])('%s', (_name, flag, expected) => {
    const path = write('root.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', toolUse('toolu-1')),
      toolResults('2026-10-01T10:00:01.000Z', [
        { type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok', ...flag },
      ]),
    ])

    const tool = parseSessionFile(path).requests[0]!.tools[0]!

    expect(tool.isError).toBe(expected)
    // Поле отсутствует, а не лежит `undefined`: так «не знаем» и видно в
    // объекте, и ложится в `NULL`, а не в 0.
    expect('isError' in tool).toBe(expected !== undefined)
  })

  it('вызов без результата — isError отсутствует, а не false', () => {
    const path = write('root.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', toolUse('toolu-1')),
    ])

    const tool = parseSessionFile(path).requests[0]!.tools[0]!

    expect('isError' in tool).toBe(false)
  })

  it('статус берётся у своего вызова: параллельные результаты в одной записи', () => {
    const path = write('root.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', toolUse('toolu-1')),
      assistant('req-1', '2026-10-01T10:00:00.100Z', toolUse('toolu-2')),
      assistant('req-1', '2026-10-01T10:00:00.200Z', toolUse('toolu-3')),
      toolResults('2026-10-01T10:00:01.000Z', [
        { type: 'tool_result', tool_use_id: 'toolu-3', content: 'ok', is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok', is_error: false },
      ]),
    ])

    const tools = parseSessionFile(path).requests[0]!.tools

    expect(tools.map((tool) => [tool.id, tool.isError])).toEqual([
      ['toolu-1', false],
      ['toolu-2', undefined],
      ['toolu-3', true],
    ])
  })
})

describe('голова последнего ответа сабагента', () => {
  it('у сабагента голова есть', () => {
    const path = write('agent-a1.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('принят с оговорками'), {
        sidechain: true,
      }),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe(
      'принят с оговорками',
    )
  })

  /**
   * У корня поле не заполняется вовсе: главная сессия с тем же текстом и
   * сабагент-ревьюер — разные вещи, а вердикт читается только у второго.
   */
  it('корневая сессия с текстом: поля нет', () => {
    const path = write('root.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('привет'), { sidechain: false }),
      assistant('req-2', '2026-10-01T10:00:05.000Z', text('готово'), { sidechain: false }),
    ])

    expect('lastTextHead' in parseSessionFile(path).session).toBe(false)
  })

  /**
   * Файл сабагента — сабагент по месту и имени, а не по флагу внутри записей
   * (правило 4 `CLAUDE.md` о том же: идентичность из имени файла). Расползись
   * флаг в новой версии CLI, голова пропала бы у всех ревьюеров, а экран
   * показал бы «вердикта нет».
   */
  it('сабагент без флага isSidechain в записях всё равно получает голову', () => {
    const records = [assistant('req-1', '2026-10-01T10:00:00.000Z', text('принят'))]
    const path = write('agent-a2.jsonl', records)

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe('принят')
    expect('lastTextHead' in parseSessionFile(path).session).toBe(false)
  })

  it('голова — последний текстовый блок, а не первый', () => {
    const path = write('agent-a3.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('сверяю дифф'), { sidechain: true }),
      assistant('req-2', '2026-10-01T10:00:10.000Z', text('принят'), { sidechain: true }),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe('принят')
  })

  /**
   * Порядок записей не хронологический (правило 10): у блока, лежащего в файле
   * последним, метка может быть раньше, чем у предыдущего. Нужен последний в
   * файле, а не самый поздний по времени.
   */
  it('голова — последний блок в файле, а не самый поздний по метке', () => {
    const path = write('agent-a4.jsonl', [
      assistant('req-1', '2026-10-01T10:00:20.000Z', text('не принят: черновик'), {
        sidechain: true,
      }),
      assistant('req-1', '2026-10-01T10:00:10.000Z', text('принят'), { sidechain: true }),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe('принят')
  })

  it('голова — последний текстовый блок, а не блок последней записи', () => {
    const path = write('agent-a5.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('принят'), { sidechain: true }),
      assistant('req-2', '2026-10-01T10:00:10.000Z', toolUse('toolu-1'), { sidechain: true }),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe('принят')
  })

  it('мысли и вызовы текстом не считаются', () => {
    const path = write('agent-a6.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('принят'), { sidechain: true }),
      assistant(
        'req-2',
        '2026-10-01T10:00:10.000Z',
        { type: 'thinking', thinking: 'хм, а точно ли', signature: 'x' },
        { sidechain: true },
      ),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe('принят')
  })

  it('пустой блок не перебивает предыдущий', () => {
    const path = write('agent-a7.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('принят'), { sidechain: true }),
      assistant('req-2', '2026-10-01T10:00:10.000Z', text('\n  '), { sidechain: true }),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe('принят')
  })

  it('текста нет вовсе — поля нет, а не пустая строка', () => {
    const path = write('agent-a8.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', toolUse('toolu-1'), { sidechain: true }),
    ])

    expect('lastTextHead' in parseSubagentFile(path, 'parent-session').session).toBe(false)
  })

  it('голова хранится как написана: без обрезки пробелов и разметки', () => {
    const path = write('agent-a9.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text('**Принят с оговорками.**\n\nТекст'), {
        sidechain: true,
      }),
    ])

    expect(parseSubagentFile(path, 'parent-session').session.lastTextHead).toBe(
      '**Принят с оговорками.**\n\nТекст',
    )
  })
})

describe('обрезка головы — 200 кодпоинтов', () => {
  const head = (value: string): string => {
    const path = write('agent-b1.jsonl', [
      assistant('req-1', '2026-10-01T10:00:00.000Z', text(value), { sidechain: true }),
    ])
    return parseSubagentFile(path, 'parent-session').session.lastTextHead!
  }

  /**
   * Двухсотый кодпоинт — 🧪, и в UTF-16 это две единицы. Срез по единицам
   * оставил бы от него половину суррогатной пары, которую SQLite молча
   * запишет как U+FFFD: голова в индексе разошлась бы с логом, а ошибки не
   * было бы нигде.
   */
  it('эмодзи на границе не рвётся пополам', () => {
    const value = `${'я'.repeat(199)}🧪хвост`

    const result = head(value)

    expect(result).toBe(`${'я'.repeat(199)}🧪`)
    expect(Array.from(result)).toHaveLength(200)
    expect(result.isWellFormed()).toBe(true)
  })

  it.each([
    ['короче границы', 'я'.repeat(50), 'я'.repeat(50)],
    ['ровно 200', 'я'.repeat(200), 'я'.repeat(200)],
    ['201', 'я'.repeat(201), 'я'.repeat(200)],
    ['кириллица, много длиннее', 'ж'.repeat(5000), 'ж'.repeat(200)],
    ['эмодзи с первых символов', '🧪'.repeat(300), '🧪'.repeat(200)],
  ])('%s', (_name, value, expected) => {
    expect(head(value)).toBe(expected)
  })
})

describe('Codex', () => {
  /**
   * Ни `is_error`, ни головы у Codex нет, и это «не знаем», а не «ошибок не
   * было»: ничего из `sources/codex/**` в 9.1 не трогается.
   */
  it('вызовы без isError, сессия без головы', () => {
    const { session, requests } = parseRolloutFile(codexFixture)
    const tools = requests.flatMap((request) => request.tools)

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some((tool) => 'isError' in tool)).toBe(false)
    expect('lastTextHead' in session).toBe(false)
  })
})
