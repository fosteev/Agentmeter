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
