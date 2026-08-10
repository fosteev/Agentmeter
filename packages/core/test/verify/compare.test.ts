import { describe, expect, it } from 'vitest'
import { compareOne, lastPrefix, missingModels, sumRequests } from '../../src/verify/compare.ts'
import type { Request } from '../../src/sources/types.ts'

function req(partial: Partial<Request>): Request {
  return {
    sessionId: 's1',
    seq: 0,
    requestId: 'req_1',
    ts: 0,
    model: 'claude-opus-5',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    contextTokens: 0,
    isSidechain: false,
    compacted: false,
    synthetic: false,
    origin: 'log',
    tools: [],
    ...partial,
  }
}

describe('сверка с эталоном', () => {
  it('суммирует запросы по всем четырём статьям', () => {
    const totals = sumRequests([
      req({ input: 2, output: 100, cacheWrite: 1000, cacheRead: 20000 }),
      req({ input: 1, output: 50, cacheWrite: 500, cacheRead: 21000 }),
    ])
    expect(totals).toEqual({ input: 3, output: 150, cacheWrite: 1500, cacheRead: 41000 })
  })

  it('сошедшаяся сессия помечается точной', () => {
    const requests = [req({ input: 2, output: 100, cacheWrite: 1000, cacheRead: 20000 })]
    const c = compareOne(
      {
        project: 'proj-00',
        sessionId: 's1',
        totals: { input: 2, output: 100, cacheWrite: 1000, cacheRead: 20000 },
      },
      requests,
    )
    expect(c.exact).toBe(true)
    expect(c.cacheReadDrift).toBe(0)
  })

  it('хвостовая недостача считается в целых префиксах', () => {
    // Последний запрос: префикс 21000 + 500 = 21500. Эталон больше ровно на
    // два таких префикса — два служебных запроса после последнего ответа.
    const requests = [
      req({ cacheRead: 20000, cacheWrite: 1000 }),
      req({ seq: 1, cacheRead: 21000, cacheWrite: 500 }),
    ]
    expect(lastPrefix(requests)).toBe(21500)
    const c = compareOne(
      {
        project: 'proj-01',
        sessionId: 's1',
        totals: { input: 0, output: 0, cacheWrite: 1500, cacheRead: 41000 + 43000 },
      },
      requests,
    )
    expect(c.tailUnits).toBe(2)
    expect(c.exact).toBe(false)
  })

  it('модель, которой нет в транскрипте, попадает в список недостающих', () => {
    const requests = [req({ model: 'claude-opus-5', output: 100 })]
    const found = missingModels(
      {
        'claude-opus-5': { outputTokens: 100 },
        'claude-haiku-4-5-20251001': { inputTokens: 64298, outputTokens: 6951 },
      },
      requests,
    )
    expect(found).toEqual(['claude-haiku-4-5-20251001'])
  })

  it('модель без единого токена недостачей не считается', () => {
    const found = missingModels({ 'claude-haiku-4-5': { inputTokens: 0, outputTokens: 0 } }, [
      req({}),
    ])
    expect(found).toEqual([])
  })

  it('пустая сессия не делит на ноль', () => {
    const c = compareOne(
      {
        project: 'proj-02',
        sessionId: 's1',
        totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      },
      [],
    )
    expect(c.cacheReadDrift).toBe(0)
    expect(c.tailUnits).toBeUndefined()
  })
})
