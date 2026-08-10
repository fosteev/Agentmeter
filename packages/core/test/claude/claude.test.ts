import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { listLiveSessions, parseSessionFile, parseSubagents } from '../../src/index.ts'
import { parseProcStart } from '../../src/sources/claude/live.ts'
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
    const startedAt = Date.now()
    writeFileSync(
      join(tmp, `${process.pid}.json`),
      JSON.stringify({
        sessionId: 'live-session',
        cwd: '/proj/live',
        startedAt,
        entrypoint: 'claude-vscode',
        version: '2.1.220',
        name: 'Claude Code',
      }),
    )
    writeFileSync(
      join(tmp, '99999999.json'),
      JSON.stringify({
        sessionId: 'dead-session',
        cwd: '/proj/dead',
        startedAt,
        entrypoint: 'cli',
      }),
    )

    expect(listLiveSessions(tmp)).toEqual([
      {
        pid: process.pid,
        sessionId: 'live-session',
        provider: 'claude',
        cwd: '/proj/live',
        startedAt,
        // На диске лежит `claude-vscode`, в контракте 0.2 — `vscode`. Без
        // нормализации 8 живых сессий из 9 схлопывались в `unknown`.
        entrypoint: 'vscode',
        cliVersion: '2.1.220',
        name: 'Claude Code',
      },
    ])
  })

  // Ловит вечного агента в трее: файл сессии остаётся после падения процесса,
  // а система рано или поздно выдаёт тот же pid другому. `kill(pid, 0)` тогда
  // честно отвечает «жив» — про чужого.
  it('listLiveSessions отбрасывает переиспользованный pid', () => {
    if (process.platform === 'win32') return
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-live-'))
    mkdirSync(tmp, { recursive: true })
    writeFileSync(
      join(tmp, `${process.pid}.json`),
      JSON.stringify({
        sessionId: 'stale-session',
        cwd: '/proj/stale',
        startedAt: Date.now() - 48 * 60 * 60 * 1000,
        entrypoint: 'cli',
      }),
    )

    expect(listLiveSessions(tmp)).toEqual([])
  })

  // Ловит разбор `procStart` как локального времени: поле выглядит локальным,
  // а написано в UTC, и на зоне +3 промах в три часа объявляет переиспользо-
  // ванным каждый живой pid.
  it('procStart разбирается как UTC', () => {
    expect(parseProcStart('Mon Aug 10 07:11:48 2026')).toBe(Date.parse('2026-08-10T07:11:48.000Z'))
    expect(parseProcStart('что-то другое')).toBeUndefined()
  })

  /**
   * Слово провайдера сильнее вывода по числам (4.4).
   *
   * Запись `compact_boundary` встречается на всех живых логах **один раз** — и
   * в фикстурах её нет вовсе, поэтому случай сеется здесь. Контекст в этом
   * транскрипте нарочно не падает: вывод по числам такой компакт не увидит, и
   * поймать потерю разметки может только эта проверка. Обратная половина
   * правила — на фикстуре `compact.jsonl`, где разметки нет, а числа есть.
   */
  it('компакт, размеченный провайдером, не выводится из чисел', () => {
    tmp = mkdtempSync(join(tmpdir(), 'agentmeter-compact-'))
    const path = join(tmp, 'marked.jsonl')
    writeFileSync(
      path,
      [
        assistantLine('req-1', '2026-08-10T10:00:00.000Z', { write: 20_000, read: 0 }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          timestamp: '2026-08-10T10:01:00.000Z',
          compactMetadata: { trigger: 'auto', preTokens: 20_000 },
        }),
        assistantLine('req-2', '2026-08-10T10:02:00.000Z', { write: 500, read: 20_000 }),
      ].join('\n'),
    )

    const requests = parseSessionFile(path).requests

    expect(requests.map((request) => request.compacted)).toEqual([false, true])
    // Контекст не падал: 20 000 против 20 500. Правило по числам молчит, и это
    // ровно то, ради чего разметка провайдера читается отдельно.
    expect(requests.map((request) => request.contextTokens)).toEqual([20_000, 20_500])
  })
})

function assistantLine(
  requestId: string,
  timestamp: string,
  usage: { write: number; read: number },
): string {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp,
    sessionId: 'marked-session',
    cwd: '/proj/marked',
    version: '2.1.226',
    isSidechain: false,
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 10,
        cache_creation_input_tokens: usage.write,
        cache_read_input_tokens: usage.read,
        cache_creation: { ephemeral_1h_input_tokens: usage.write, ephemeral_5m_input_tokens: 0 },
      },
    },
  })
}

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
