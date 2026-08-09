import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
