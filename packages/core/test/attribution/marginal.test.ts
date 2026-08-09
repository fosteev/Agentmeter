import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attributeMarginal,
  parseRolloutFile,
  parseSessionFile,
  type MarginalBasis,
  type Provider,
  type Request,
  type ToolCall,
} from '../../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../../../fixtures/attribution/', import.meta.url))

interface ExpectedTool {
  id: string
  resultBytes: number
  hasImage?: boolean
  marginalTokens: number
  marginalBasis: MarginalBasis
}

interface ExpectedAttribution {
  provider: Provider
  requests: Array<{
    seq: number
    origin: 'log' | 'reconstructed'
    contextTokens: number
    output: number
    tools: ExpectedTool[]
  }>
  totals: {
    attributedTokens: number
    calls: number
    measured: number
    split: number
    unknown: number
  }
}

describe('marginal attribution', () => {
  for (const provider of ['claude', 'codex'] as const) {
    it(`совпадает с ручным эталоном ${provider}`, () => {
      const expected = readExpected(join(fixturesDir, `${provider}-chain.expected.json`))
      const result =
        provider === 'claude'
          ? parseSessionFile(join(fixturesDir, 'claude-chain.jsonl'))
          : parseRolloutFile(join(fixturesDir, 'codex-chain.jsonl'))
      const stats = attributeMarginal(result.requests, provider)

      // Сначала — что цепочка разобрана ровно так, как её считали руками.
      // Иначе расхождение по marginalTokens придётся объяснять дважды: сломался
      // разбор или сломалась атрибуция.
      expect(
        result.requests.map((request) => ({
          seq: request.seq,
          origin: request.origin,
          contextTokens: request.contextTokens,
          output: request.output,
          tools: request.tools.map((tool) => ({
            id: tool.id,
            resultBytes: tool.resultBytes,
            ...(tool.hasImage ? { hasImage: true } : {}),
          })),
        })),
      ).toEqual(
        expected.requests.map((request) => ({
          seq: request.seq,
          origin: request.origin,
          contextTokens: request.contextTokens,
          output: request.output,
          tools: request.tools.map((tool) => ({
            id: tool.id,
            resultBytes: tool.resultBytes,
            ...(tool.hasImage ? { hasImage: true } : {}),
          })),
        })),
      )

      expect(
        result.requests.flatMap((request) =>
          request.tools.map((tool) => ({
            seq: request.seq,
            id: tool.id,
            marginalTokens: tool.marginalTokens,
            marginalBasis: tool.marginalBasis,
          })),
        ),
      ).toEqual(
        expected.requests.flatMap((request) =>
          request.tools.map((tool) => ({
            seq: request.seq,
            id: tool.id,
            marginalTokens: tool.marginalTokens,
            marginalBasis: tool.marginalBasis,
          })),
        ),
      )
      expect(stats).toEqual({
        measured: expected.totals.measured,
        split: expected.totals.split,
        unknown: expected.totals.unknown,
        attributed: expected.totals.attributedTokens,
      })
      expect(result.requests.flatMap((request) => request.tools)).toHaveLength(
        expected.totals.calls,
      )
    })
  }

  it('оставляет единственный запрос неизвестным', () => {
    const requests = [makeRequest({ tools: [makeTool('only')] })]

    expect(attributeMarginal(requests, 'claude')).toEqual({
      measured: 0,
      split: 0,
      unknown: 1,
      attributed: 0,
    })
    expect(requests[0]?.tools[0]).toMatchObject({
      marginalTokens: 0,
      marginalBasis: 'unknown',
    })
  })

  it('принимает пустую сессию', () => {
    expect(attributeMarginal([], 'codex')).toEqual({
      measured: 0,
      split: 0,
      unknown: 0,
      attributed: 0,
    })
  })

  it('делит нечётный остаток десяти нулевым весам детерминированно', () => {
    const requests = [
      makeRequest({ tools: Array.from({ length: 10 }, (_, index) => makeTool(`tool-${index}`)) }),
      makeRequest({ seq: 1, requestId: 'request-1', contextTokens: 111 }),
    ]

    const stats = attributeMarginal(requests, 'codex')

    expect(requests[0]?.tools.map((tool) => tool.marginalTokens)).toEqual([
      2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ])
    expect(requests[0]?.tools.every((tool) => tool.marginalBasis === 'split')).toBe(true)
    expect(stats).toEqual({ measured: 0, split: 10, unknown: 0, attributed: 11 })
  })
})

function readExpected(path: string): ExpectedAttribution {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedAttribution
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    sessionId: 'session',
    seq: 0,
    requestId: 'request-0',
    ts: 0,
    model: 'model',
    origin: 'log',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    contextTokens: 100,
    isSidechain: false,
    compacted: false,
    synthetic: false,
    interjectedBytes: 0,
    tools: [],
    ...overrides,
  }
}

function makeTool(id: string): ToolCall {
  return {
    id,
    name: 'exec_command',
    kind: 'builtin',
    resultBytes: 0,
    marginalTokens: 0,
    marginalBasis: 'unknown',
    hasImage: false,
  }
}
