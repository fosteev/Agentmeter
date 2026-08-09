import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRolloutFile, readLimits } from '../../src/index.ts'
import type { LimitObservation, ParseResult, Request, Session, ToolCall } from '../../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const rolloutPath = join(fixturesDir, 'rollout.jsonl')

let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

describe('Codex parser', () => {
  it('разбирает фикстуру Codex и совпадает с expected.json', () => {
    const actual = parseRolloutFile(rolloutPath)
    const expected = readExpected(join(fixturesDir, 'rollout.expected.json'))

    expect(projectResult(actual, expected)).toEqual(expected)
  })

  it('сумма last_token_usage сходится с последним total_token_usage из лога', () => {
    const actual = parseRolloutFile(rolloutPath)
    const expected = readLastTotalTokenUsage(rolloutPath)
    const totals = sumTotals(actual.requests)

    expect(totals.output).toBe(expected.output_tokens)
    expect(totals.input + totals.cacheRead).toBe(expected.input_tokens)
    expect(totals.reasoning).toBe(expected.reasoning_output_tokens)
  })

  it('readLimits возвращает наблюдения в порядке появления', () => {
    const actual = readLimits(rolloutPath)
    const expectedResets = readLimitResets(rolloutPath)

    expect(actual).toHaveLength(16)
    expect(actual.map((observation) => observation.resetsAt)).toEqual(
      expectedResets.map((value) => value * 1000),
    )
    expect(projectLimit(actual[0])).toEqual({
      usedPercent: 1,
      windowMinutes: 300,
      resetsAt: 1781531144000,
    })
    // Имени слота в наблюдении нет: с Codex CLI 0.145.0 `primary` стал
    // недельным, и раскладка по слотам показала бы неделю как пять часов.
    expect(Object.keys(actual[0])).toEqual(['ts', 'windowMinutes', 'usedPercent', 'resetsAt'])
  })

  it('повторный token_count с тем же итогом не удваивает запрос', () => {
    // На диске так пишет большинство версий CLI: один ответ API — две записи
    // token_count подряд. Фикстура такой сессии не содержит, а наивный подсчёт
    // завышал расход почти вдвое на 174 сессиях из 311.
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-codex-'))
    const path = join(tmp, 'dup.jsonl')
    const usage = (input: number, output: number) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    })
    const tokenCount = (ts: string, last: object, total: object) =>
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: last, total_token_usage: total },
        },
      })

    writeFileSync(
      path,
      [
        tokenCount('2026-06-15T08:00:01.000Z', usage(100, 10), usage(100, 10)),
        tokenCount('2026-06-15T08:00:02.000Z', usage(100, 10), usage(100, 10)),
        JSON.stringify({
          timestamp: '2026-06-15T08:00:03.000Z',
          type: 'compacted',
          payload: { message: '' },
        }),
        tokenCount('2026-06-15T08:00:04.000Z', usage(50, 5), usage(150, 15)),
      ].join('\n'),
    )

    const { requests } = parseRolloutFile(path)
    expect(requests.map((request) => [request.input, request.output, request.compacted])).toEqual([
      [100, 10, false],
      [50, 5, true],
    ])
  })

  it('мусор не роняет разбор и попадает в диагностику', () => {
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-codex-'))
    const path = join(tmp, 'garbage.jsonl')
    writeFileSync(
      path,
      [
        'not json',
        JSON.stringify({
          timestamp: '2026-06-15T08:45:57.659Z',
          type: 'event_msg',
          payload: { type: 'never_seen_before' },
        }),
      ].join('\n'),
    )

    const actual = parseRolloutFile(path)
    expect(actual.diagnostics.malformedLines).toBe(1)
    expect(actual.diagnostics.unknownRecordTypes).toEqual({ 'event_msg/never_seen_before': 1 })
  })
})

interface ExpectedResult {
  checks?: string
  session: Record<string, unknown>
  requests: Record<string, unknown>[]
  totals: Record<string, number>
  totalTokenUsage?: Record<string, number>
  unknownTypes: Record<string, number>
  limits?: Record<string, unknown>[]
}

interface TokenUsage {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}

function readExpected(path: string): ExpectedResult {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedResult
}

function projectResult(actual: ParseResult, expected: ExpectedResult): ExpectedResult {
  return {
    ...(expected.checks === undefined ? {} : { checks: expected.checks }),
    session: projectSession(actual.session, expected.session),
    requests: actual.requests.map((request, index) =>
      projectRequest(request, expected.requests[index]),
    ),
    totals: sumTotals(actual.requests),
    ...(expected.totalTokenUsage === undefined
      ? {}
      : { totalTokenUsage: readLastTotalTokenUsage(actual.session.sourcePath) }),
    unknownTypes: actual.diagnostics.unknownRecordTypes,
    ...(expected.limits === undefined
      ? {}
      : { limits: readLimits(actual.session.sourcePath).map(projectLimit) }),
  }
}

function projectSession(
  session: Session,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(expected)) {
    const value = session[key as keyof Session]
    projected[key] =
      key === 'startedAt' || key === 'endedAt' ? new Date(value as number).toISOString() : value
  }
  return projected
}

function projectRequest(
  request: Request,
  expected: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!expected) throw new Error(`unexpected request ${request.requestId}`)
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(expected)) {
    if (key === 'ts') {
      projected.ts = new Date(request.ts).toISOString()
    } else if (key === 'tools') {
      const expectedTools = expected.tools
      if (!Array.isArray(expectedTools)) throw new Error('expected tools must be an array')
      projected.tools = request.tools.map((tool, index) => projectTool(tool, expectedTools[index]))
    } else {
      projected[key] = request[key as keyof Request]
    }
  }
  return projected
}

function projectTool(tool: ToolCall, expected: unknown): Record<string, unknown> {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error(`unexpected tool ${tool.id}`)
  }
  const expectedTool = expected as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(expectedTool)) {
    projected[key] = tool[key as keyof ToolCall]
  }
  return projected
}

function projectLimit(observation: LimitObservation | undefined): Record<string, unknown> {
  if (!observation) throw new Error('missing limit observation')
  return {
    usedPercent: observation.usedPercent,
    windowMinutes: observation.windowMinutes,
    resetsAt: observation.resetsAt,
  }
}

function sumTotals(requests: Request[]): Record<string, number> {
  return requests.reduce(
    (totals, request) => {
      totals.input += request.input
      totals.output += request.output
      totals.cacheWrite += request.cacheWrite
      totals.cacheRead += request.cacheRead
      totals.reasoning += request.reasoning ?? 0
      return totals
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
  )
}

function readLastTotalTokenUsage(path: string): TokenUsage {
  let total: TokenUsage | undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as unknown
    if (!isObject(record)) continue
    const payload = objectField(record, 'payload')
    const info = objectField(payload ?? {}, 'info')
    const usage = objectField(info ?? {}, 'total_token_usage')
    if (usage) {
      total = {
        input_tokens: numberField(usage, 'input_tokens') ?? 0,
        cached_input_tokens: numberField(usage, 'cached_input_tokens') ?? 0,
        output_tokens: numberField(usage, 'output_tokens') ?? 0,
        reasoning_output_tokens: numberField(usage, 'reasoning_output_tokens') ?? 0,
        total_tokens: numberField(usage, 'total_tokens') ?? 0,
      }
    }
  }
  if (!total) throw new Error('total_token_usage not found')
  return total
}

function readLimitResets(path: string): number[] {
  const resets: number[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as unknown
    if (!isObject(record)) continue
    const payload = objectField(record, 'payload')
    const rateLimits = objectField(payload ?? {}, 'rate_limits')
    if (!rateLimits) continue
    for (const kind of ['primary', 'secondary']) {
      const window = objectField(rateLimits, kind)
      const resetsAt = window ? numberField(window, 'resets_at') : undefined
      if (resetsAt !== undefined) resets.push(resetsAt)
    }
  }
  return resets
}

function objectField(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return isObject(object[key]) ? object[key] : undefined
}

function numberField(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
