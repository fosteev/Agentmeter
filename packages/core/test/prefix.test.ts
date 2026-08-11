import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attributePrefix,
  parseRolloutFile,
  parseSessionFile,
  type PrefixBlock,
  type Provider,
} from '../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../../fixtures/prefix/', import.meta.url))

interface ExpectedPrefix {
  provider: Provider
  toolsDeferred: boolean
  prefixTokens: number
  requestCount: number
  recurrentTokens: number
  blocks: PrefixBlock[]
}

describe('prefix attribution', () => {
  for (const name of ['claude-prefix', 'claude-eager', 'codex-prefix']) {
    it(`совпадает с ручным эталоном ${name}`, () => {
      const expected = JSON.parse(
        readFileSync(join(fixturesDir, `${name}.expected.json`), 'utf8'),
      ) as ExpectedPrefix
      const result =
        expected.provider === 'claude'
          ? parseSessionFile(join(fixturesDir, `${name}.jsonl`))
          : parseRolloutFile(join(fixturesDir, `${name}.jsonl`))

      expect(result.session.provider).toBe(expected.provider)
      expect(result.session.toolsDeferred).toBe(expected.toolsDeferred)
      expect(result.session.prefixTokens).toBe(expected.prefixTokens)
      expect(result.requests.filter((request) => request.origin === 'log')).toHaveLength(
        expected.requestCount,
      )
      expect(result.session.prefixTokens * expected.requestCount).toBe(expected.recurrentTokens)
      expect(result.session.prefixBlocks).toEqual(expected.blocks)

      // Парсеры уже вызывают атрибуцию; повторный вызов не должен сдвигать цифры.
      expect(attributePrefix(result.session, result.requests)).toEqual(expected.blocks)
    })
  }
})

/**
 * Файлы памяти, которых в логе нет (долг 1.7, закрыт в 4.1).
 *
 * Сессия собирается руками, потому что на фикстурах проверять нечего: путь в
 * записи `nested_memory` там указывает в никуда (`/proj/e/lorem ips`), файла на
 * диске не существует, и защита от двойного счёта не срабатывает ни разу — то
 * есть проверка была бы зелена и без неё.
 */
describe('внешние файлы памяти', () => {
  const text = 'память проекта, 60 байт в utf-8 ровно для наглядности'
  const size = Buffer.byteLength(text, 'utf8')

  function session(dir: string, memoryPath: string, declared: boolean): string {
    const lines = [
      {
        type: 'user',
        cwd: dir,
        sessionId: 'memory-guard',
        uuid: '0195c1a0-2222-4000-8000-000000000001',
        timestamp: '2026-08-09T10:00:00.000Z',
        message: { role: 'user', content: 'вопрос' },
      },
      ...(declared
        ? [
            {
              type: 'attachment',
              uuid: '0195c1a0-2222-4000-8000-000000000002',
              timestamp: '2026-08-09T10:00:00.500Z',
              attachment: { type: 'nested_memory', path: memoryPath, content: { content: text } },
            },
          ]
        : []),
      {
        type: 'assistant',
        uuid: '0195c1a0-2222-4000-8000-000000000003',
        timestamp: '2026-08-09T10:00:01.000Z',
        requestId: 'req_memory_guard',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 20_000,
            cache_read_input_tokens: 0,
          },
        },
      },
    ]
    const path = join(dir, 'memory-guard.jsonl')
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    return path
  }

  function memoryBytes(path: string, memoryPaths: string[]): number {
    return parseSessionFile(path, { memoryPaths })
      .session.prefixBlocks.filter((block) => block.category === 'memory')
      .reduce((sum, block) => sum + block.bytes, 0)
  }

  let dir: string
  let memoryPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentmeter-memory-'))
    memoryPath = join(dir, 'MEMORY.md')
    writeFileSync(memoryPath, text)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Ловит статью «память», выросшую на файл, которого никто не подключал. */
  it('без списка путей внешний файл не считается вовсе', () => {
    expect(memoryBytes(session(dir, memoryPath, false), [])).toBe(0)
    expect(memoryBytes(session(dir, memoryPath, false), [memoryPath])).toBe(size)
  })

  /**
   * Ловит файл, посчитанный дважды: лог уже назвал его записью `nested_memory`,
   * и вторая копия из списка путей удвоила бы статью, забрав ту же величину из
   * остатка `system`. Сумма блоков при этом сходится с префиксом, и заметить
   * подмену по тождеству нельзя.
   */
  it('файл, названный логом, не считается второй раз из списка путей', () => {
    const path = session(dir, memoryPath, true)

    expect(memoryBytes(path, [])).toBe(size)
    expect(memoryBytes(path, [memoryPath])).toBe(size)
    expect(memoryBytes(path, [memoryPath, memoryPath])).toBe(size)
  })
})

/**
 * Имена штук внутри статьи (4.9).
 *
 * Сессия собирается руками по той же причине, что и выше: в фикстурах листинги
 * обезличены, а `names` в них есть везде — то есть запасной путь через
 * регулярку на них не выполняется ни разу, и проверка была бы зелена при любом
 * его поведении.
 */
describe('состав статей префикса', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentmeter-prefix-names-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Листинг с обеими формами записи. Провайдер пишет их вперемешку: у скилла с
   * описанием оно есть, у скилла без описания — нет, и `- имя` без двоеточия
   * регулярка не видит.
   */
  const LISTING = ['- alpha', '- beta: делает что-то полезное', '- gamma'].join('\n')

  function session(attachment: Record<string, unknown>): string {
    const lines = [
      {
        type: 'user',
        cwd: dir,
        sessionId: 'prefix-names',
        uuid: '0195c1a0-3333-4000-8000-000000000001',
        timestamp: '2026-08-09T10:00:00.000Z',
        message: { role: 'user', content: 'вопрос' },
      },
      {
        type: 'attachment',
        uuid: '0195c1a0-3333-4000-8000-000000000002',
        timestamp: '2026-08-09T10:00:00.500Z',
        attachment,
      },
      {
        type: 'assistant',
        uuid: '0195c1a0-3333-4000-8000-000000000003',
        timestamp: '2026-08-09T10:00:01.000Z',
        requestId: 'req_prefix_names',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 20_000,
            cache_read_input_tokens: 0,
          },
        },
      },
    ]
    const path = join(dir, 'prefix-names.jsonl')
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    return path
  }

  function block(path: string, category: PrefixBlock['category']): PrefixBlock {
    return parseSessionFile(path).session.prefixBlocks.find(
      (candidate) => candidate.category === category,
    )!
  }

  /**
   * Ловит счёт по регулярке при живом массиве имён — ту самую ошибку, которой
   * этап и вызван: на живых логах она давала 12 скиллов вместо 36 в худшей
   * сессии, и строка экрана врала втрое, ничего не ломая.
   */
  it('штуки считаются по массиву имён, а не по строкам листинга', () => {
    const listed = block(
      session({ type: 'skill_listing', content: LISTING, names: ['alpha', 'beta', 'gamma'] }),
      'skills',
    )

    expect(listed.items).toBe(3)
    expect(listed.names).toEqual(['alpha', 'beta', 'gamma'])
  })

  /**
   * Ловит выдуманные имена там, где источник их не назвал: разбор текста
   * листинга дал бы список из одной записи, и он выглядел бы полным.
   */
  it('без массива имён остаётся счёт по листингу и ни одного имени', () => {
    const listed = block(session({ type: 'skill_listing', content: LISTING }), 'skills')

    expect(listed.items).toBe(1)
    expect(listed.names).toBeUndefined()
  })

  /** То же правило у сабагентов: имена лежат в `addedTypes`. */
  it('сабагенты берут имена из своего массива', () => {
    const listed = block(
      session({
        type: 'agent_listing_delta',
        addedLines: LISTING.split('\n'),
        addedTypes: ['alpha', 'beta', 'gamma'],
      }),
      'agents',
    )

    expect(listed.items).toBe(3)
    expect(listed.names).toEqual(['alpha', 'beta', 'gamma'])
  })

  /**
   * Ловит подпись вместо идентичности: `displayPath` относителен рабочему
   * каталогу, и тот же файл в другой сессии записан другой строкой — склейка по
   * нему превратила бы один файл в несколько.
   */
  it('файл памяти назван абсолютным путём, а не показанным', () => {
    const listed = block(
      session({
        type: 'nested_memory',
        path: '/fixture/memory/CLAUDE.md',
        displayPath: '../CLAUDE.md',
        content: { content: 'память' },
      }),
      'memory',
    )

    expect(listed.names).toEqual(['/fixture/memory/CLAUDE.md'])
  })

  /**
   * Ловит список, склеенный из блоков, где имена назвал не каждый: половина
   * состава на экране выглядит целым составом, и заметить подмену нечем.
   * Проверяется прямым вызовом атрибуции — на живых логах такой пары блоков
   * пока не бывает, а правило нужно до того, как она появится.
   */
  it('в склейке имена остаются только если их назвали все слагаемые', () => {
    const blocks: PrefixBlock[] = [
      { category: 'skills', bytes: 100, tokens: 0, basis: 'estimated', items: 1, names: ['alpha'] },
      { category: 'skills', bytes: 100, tokens: 0, basis: 'estimated', items: 1 },
    ]
    const session = { provider: 'claude', prefixTokens: 0, prefixBlocks: blocks } as never

    const merged = attributePrefix(session, [])

    expect(merged.find((block) => block.category === 'skills')).toMatchObject({ items: 2 })
    expect(merged.find((block) => block.category === 'skills')!.names).toBeUndefined()
  })

  /**
   * Ловит склейку списка с блоком, у которого имён нет: отложенные тулы
   * приезжают по блоку на имя и схлопываются в один, и «часть имён» на экране
   * выглядит полным составом.
   */
  it('отложенные тулы схлопываются в один блок со всеми именами', () => {
    const listed = block(
      session({ type: 'deferred_tools_delta', addedNames: ['CronList', 'WebFetch'] }),
      'deferredTools',
    )

    expect(listed.items).toBe(2)
    expect(listed.names).toEqual(['CronList', 'WebFetch'])
  })
})
