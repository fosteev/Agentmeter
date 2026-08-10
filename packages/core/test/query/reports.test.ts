import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  breakdownReport,
  doctorReport,
  ensureLimitWindows,
  ingestFile,
  limitsReport,
  taskRows,
  todayReport,
  type DayRange,
  type SourceFile,
  type Totals,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

const claudeDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const expectedTotals: Totals = {
  input: 60_064,
  output: 55_349,
  cacheWrite: 338_669,
  cacheRead: 5_296_487,
  total: 5_750_569,
  requests: 134,
}
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-query-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('query reports', () => {
  it('пинит ручные итоги всех фикстур и сохраняет восстановленные запросы', () => {
    ingestFixtures()

    const report = todayReport(db, allTime)

    expect(report.totals).toEqual(expectedTotals)
    expect(report.sessions).toBe(10)
    expect(report.approximate).toBe(true)
    expect(report.emptyIndex).toBe(false)
    expect(report.emptyDay).toBe(false)
    expect(sumRows(report.providers)).toEqual(expectedTotals)
    expect(sumRows(report.models)).toEqual(expectedTotals)
    expect(sumRows(report.projects)).toEqual(expectedTotals)
    expect(sumRows(report.hours)).toEqual(expectedTotals)
  })

  it('сворачивает сабагента в родителя без потери или двойного счёта', () => {
    ingestFixtures()

    const rows = taskRows(db, allTime)
    const parent = rows.find((row) => row.sessionId === '92cc27dc-193d-4c2c-aef1-843d7d41aeab')

    expect(rows).toHaveLength(9)
    expect(rows.some((row) => row.sessionId === 'a6bf337b0067775dd')).toBe(false)
    expect(parent?.subagents).toBe(1)
    expect(sumRows(rows)).toEqual(expectedTotals)
    expect(sumRows(rows)).toEqual(todayReport(db, allTime).totals)
  })

  it('не прячет сабагента, если родителя нет в выбранном диапазоне', () => {
    ingestFixtures()
    const range = {
      from: Date.parse('2026-07-10T10:50:00.000Z'),
      to: Date.parse('2026-07-10T10:51:00.000Z'),
    }

    const rows = taskRows(db, range)

    expect(rows.some((row) => row.sessionId === 'a6bf337b0067775dd')).toBe(true)
    expect(sumRows(rows)).toEqual(todayReport(db, range).totals)
  })

  it('держит measured, split и unknown раздельно по ручному слепку 1.6', () => {
    ingestFixtures()

    const report = breakdownReport(db, { range: allTime })
    const basis = report.tool.reduce(
      (sum, row) => {
        for (const key of ['measured', 'split', 'unknown'] as const) {
          sum[key].calls += row.calls[key]
          sum[key].tokens += row.tokens[key]
        }
        return sum
      },
      {
        measured: { calls: 0, tokens: 0 },
        split: { calls: 0, tokens: 0 },
        unknown: { calls: 0, tokens: 0 },
      },
    )

    expect(report.totals).toEqual(expectedTotals)
    expect(basis).toEqual({
      measured: { calls: 61, tokens: 34_221 },
      split: { calls: 123, tokens: 89_828 },
      unknown: { calls: 2, tokens: 0 },
    })
    expect(sumRows(report.model)).toEqual(expectedTotals)
  })

  it('оставляет неизвестный процент Claude null и объясняет причину', () => {
    ingestFixtures()
    const config = structuredClone(DEFAULT_CONFIG)

    // Отчёт с 2.1 только читает: собирает окна тот, кто менял вход. В приложении
    // это `ingestAll` и живой слой, здесь — явный вызов вместо скрытой записи,
    // которая раньше пряталась внутри `limitsReport`.
    ensureLimitWindows(db, config.limits.claude)
    const report = limitsReport(db, Date.parse('2026-07-28T13:00:00.000Z'), config.limits.claude)
    const claude = report.windows.filter((window) => window.provider === 'claude')

    expect(claude).not.toHaveLength(0)
    expect(claude.every((window) => window.usedPercent === null)).toBe(true)
    expect(
      claude.every(
        (window) => window.unavailableReason === 'вес cache_read не откалиброван, этап 1.9',
      ),
    ).toBe(true)
  })

  it('doctor отличает ошибки парсера от нормального дрейфа формата', () => {
    ingestFixtures()
    db.run(
      `INSERT INTO diagnostics (source_path, kind, detail, count, cli_version, seen_at)
       VALUES ('bad', 'parser_error', 'boom', 2, '1.0', 0),
              ('new', 'unknown_record_type', 'future', 7, '2.0', 0)`,
    )

    const report = doctorReport(db, DEFAULT_CONFIG)

    expect(report.sources).toBe(10)
    expect(report.sessions).toBe(10)
    expect(report.requests).toBe(134)
    expect(report.reconstructedSessions).toBeGreaterThan(0)
    expect(report.parserErrors).toBe(2)
  })

  it('пустой индекс и пустой диапазон остаются отдельными состояниями', () => {
    const emptyIndex = todayReport(db, allTime)
    expect(emptyIndex.emptyIndex).toBe(true)
    expect(emptyIndex.emptyDay).toBe(true)

    ingestFixtures()
    const emptyDay = todayReport(db, {
      from: Date.parse('2020-01-01T00:00:00.000Z'),
      to: Date.parse('2020-01-02T00:00:00.000Z'),
    })
    expect(emptyDay.emptyIndex).toBe(false)
    expect(emptyDay.emptyDay).toBe(true)
  })
})

function ingestFixtures(): void {
  for (const name of [
    'compact',
    'images',
    'mcp',
    'parallel',
    'plain',
    'sidechain',
    'version-mid',
    'version-old',
  ]) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({
    path: join(claudeDir, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
    provider: 'claude',
    kind: 'subagent',
    parentPath: join(claudeDir, '92cc27dc-193d-4c2c-aef1-843d7d41aeab.jsonl'),
  })
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
}

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

function sumRows(rows: Array<{ totals: Totals }>): Totals {
  return rows.reduce(
    (sum, row) => ({
      input: sum.input + row.totals.input,
      output: sum.output + row.totals.output,
      cacheWrite: sum.cacheWrite + row.totals.cacheWrite,
      cacheRead: sum.cacheRead + row.totals.cacheRead,
      total: sum.total + row.totals.total,
      requests: sum.requests + row.totals.requests,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0 },
  )
}
