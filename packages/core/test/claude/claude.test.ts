import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { listLiveSessions, parseSessionFile, parseSubagents } from '../../src/index.ts'
import type { ParseResult, Request, Session, ToolCall } from '../../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))

let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

describe('Claude Code parser', () => {
  it('разбирает все фикстуры Claude и совпадает с expected.json', () => {
    const scenarios = readdirSync(fixturesDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort()

    expect(scenarios.length).toBeGreaterThan(0)
    for (const scenario of scenarios) {
      const actual = parseSessionFile(join(fixturesDir, `${scenario}.jsonl`))
      const expected = readExpected(join(fixturesDir, `${scenario}.expected.json`))
      expect(projectResult(actual, expected), scenario).toEqual(expected)
    }
  })

  it('разбирает транскрипты сабагентов через parseSubagents', () => {
    const actual = parseSubagents(join(fixturesDir, 'sidechain.jsonl')).map((result) => {
      const expectedPath = join(
        fixturesDir,
        'sidechain.subagents',
        `${basename(result.session.sourcePath, '.jsonl')}.expected.json`,
      )
      const expected = readExpected(expectedPath)
      const projected = projectResult(result, expected)
      projected.session['id'] = result.session.id
      return projected
    })
    const expected = readdirSync(join(fixturesDir, 'sidechain.subagents'))
      .filter((name) => name.endsWith('.expected.json'))
      .sort()
      .map((name) => {
        const item = readExpected(join(fixturesDir, 'sidechain.subagents', name))
        item.session['id'] = name.replace(/^agent-/, '').replace(/\.expected\.json$/, '')
        return item
      })

    expect(actual).toEqual(expected)
  })

  it('listLiveSessions читает только живые pid', () => {
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-live-'))
    mkdirSync(tmp, { recursive: true })
    writeFileSync(
      join(tmp, `${process.pid}.json`),
      JSON.stringify({
        sessionId: 'live-session',
        cwd: '/proj/live',
        startedAt: '2026-07-28T12:06:55.122Z',
        entrypoint: 'cli',
        version: '2.1.220',
        name: 'Claude Code',
      }),
    )
    writeFileSync(
      join(tmp, '99999999.json'),
      JSON.stringify({
        sessionId: 'dead-session',
        cwd: '/proj/dead',
        startedAt: 1,
        entrypoint: 'cli',
      }),
    )

    expect(listLiveSessions(tmp)).toEqual([
      {
        pid: process.pid,
        sessionId: 'live-session',
        provider: 'claude',
        cwd: '/proj/live',
        startedAt: Date.parse('2026-07-28T12:06:55.122Z'),
        entrypoint: 'cli',
        cliVersion: '2.1.220',
        name: 'Claude Code',
      },
    ])
  })
})

interface ExpectedResult {
  session: Record<string, unknown>
  requests: Record<string, unknown>[]
  totals: Record<string, number>
  unknownTypes: Record<string, number>
  checks?: string
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
    unknownTypes: actual.diagnostics.unknownRecordTypes,
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

function sumTotals(requests: Request[]): Record<string, number> {
  return requests.reduce(
    (totals, request) => {
      totals.input += request.input
      totals.output += request.output
      totals.cacheWrite += request.cacheWrite
      totals.cacheRead += request.cacheRead
      return totals
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  )
}
