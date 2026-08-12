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
  readLimitWindows,
  taskRows,
  ticketKey,
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
    expect(parent?.children.map((child) => child.sessionId)).toEqual(['a6bf337b0067775dd'])
    expect(sumRows(rows)).toEqual(expectedTotals)
    expect(sumRows(rows)).toEqual(todayReport(db, allTime).totals)
  })

  /**
   * Ловит правило извлечения тикета, взятое из головы (3.7).
   *
   * Мера подобрана на живых логах: строгая форма даёт 9 сессий и ноль ложных
   * срабатываний, а та же без учёта регистра объявляет тикетом ветку
   * `refactor/phase-3-sensors`. Здесь проверяются обе стороны: что настоящие
   * ключи находятся и что похожее на ключ ключом не считается.
   */
  it('ключ тикета берётся из ветки только в строгой форме', () => {
    expect(ticketKey('GARM-802')).toBe('GARM-802')
    expect(ticketKey('GARM-664.zigbee')).toBe('GARM-664')
    expect(ticketKey('feature/SC-248-widget')).toBe('SC-248')
    expect(ticketKey('SC-248.max_widget')).toBe('SC-248')

    expect(ticketKey('refactor/phase-3-sensors')).toBeNull()
    expect(ticketKey('refactor/T16-presentation-di-cleanup')).toBeNull()
    expect(ticketKey('develop')).toBeNull()
    expect(ticketKey('1.6.31')).toBeNull()
    expect(ticketKey(null)).toBeNull()
    expect(ticketKey('')).toBeNull()
  })

  /**
   * Ловит развёрнутый режим, забывший вычесть детей из родителя: расход
   * ребёнка попал бы и в его строку, и в строку родителя, а итог дня остался
   * бы прежним — то есть сумма строк разошлась бы с шапкой над ними, и каждое
   * число по себе выглядело бы настоящим (3.5).
   */
  it('развёрнутые сабагенты не удваивают расход', () => {
    ingestFixtures()

    const rows = taskRows(db, allTime, {}, { foldSubagents: false })
    const child = rows.find((row) => row.sessionId === 'a6bf337b0067775dd')
    const parent = rows.find((row) => row.sessionId === '92cc27dc-193d-4c2c-aef1-843d7d41aeab')
    const folded = taskRows(db, allTime).find(
      (row) => row.sessionId === '92cc27dc-193d-4c2c-aef1-843d7d41aeab',
    )

    expect(rows).toHaveLength(10)
    expect(child).toBeDefined()
    expect(child?.agentType).toBe('general-purpose')
    expect(rows.every((row) => row.children.length === 0)).toBe(true)
    // Родитель в развёрнутом режиме беднее ровно на ребёнка, а не «примерно».
    expect(parent!.totals.total + child!.totals.total).toBe(folded!.totals.total)
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

  /**
   * Ловит главное свойство 6.3: слово провайдера сильнее нашего расчёта.
   *
   * И не только по проценту. Наши границы окна — догадка («первое обращение
   * после истечения прошлого»), и на живой машине она промахнулась на три часа
   * при том, что пятичасовой паузы в запросах не было вовсе: лимит считается по
   * аккаунту, а окно могло начаться с запроса, которого у нас нет. Поэтому окно
   * заменяется целиком — иначе процент относился бы к одному интервалу, а
   * «сброс через» к другому.
   */
  it('ответ провайдера заменяет окно Claude целиком — и процент, и границы', () => {
    ingestFixtures()
    const config = structuredClone(DEFAULT_CONFIG)
    ensureLimitWindows(db, config.limits.claude)
    const at = Date.parse('2026-07-28T13:00:00.000Z')
    const resetsAt = Date.parse('2026-07-28T16:00:00.000Z')

    const ours = limitsReport(db, at, config.limits.claude).windows.find(
      (window) => window.provider === 'claude' && window.kind === 'fiveHour',
    )
    expect(ours?.resetsAt).not.toBe(resetsAt)

    const report = limitsReport(db, at, config.limits.claude, undefined, {
      ts: at,
      sessionId: '',
      source: 'oauth',
      fiveHour: { pct: 37, resetsAt },
    })
    const claude = report.windows.filter(
      (window) => window.provider === 'claude' && window.kind === 'fiveHour',
    )

    expect(claude).toHaveLength(1)
    expect(claude[0]).toMatchObject({
      usedPercent: 37,
      exact: true,
      resetsAt,
      startsAt: resetsAt - 300 * 60_000,
      unavailableReason: null,
    })
  })

  it('окна, о которых провайдер молчит, остаются нашими', () => {
    ingestFixtures()
    const config = structuredClone(DEFAULT_CONFIG)
    ensureLimitWindows(db, config.limits.claude)
    const at = Date.parse('2026-07-28T13:00:00.000Z')

    const report = limitsReport(db, at, config.limits.claude, undefined, {
      ts: at,
      sessionId: '',
      source: 'oauth',
      fiveHour: { pct: 37, resetsAt: Date.parse('2026-07-28T16:00:00.000Z') },
    })

    // Недельного окна в ответе нет — наше остаётся на месте со своим «не
    // откалибровано», а не исчезает и не притворяется точным.
    const weekly = report.windows.filter(
      (window) => window.provider === 'claude' && window.kind === 'weekly',
    )
    expect(weekly.every((window) => !window.exact && window.usedPercent === null)).toBe(true)
    // И чужой провайдер не задет вовсе.
    expect(report.windows.some((window) => window.provider === 'codex')).toBe(
      limitsReport(db, at, config.limits.claude).windows.some(
        (window) => window.provider === 'codex',
      ),
    )
  })

  /**
   * Ловит прогноз, посчитанный из воздуха: пока процент окна неизвестен,
   * продлевать в будущее нечего. У Claude это состояние сегодня штатное — вес
   * `cache_read` не откалиброван (1.9), — и «упрёшься через 40 минут» рядом с
   * прочерком в проценте было бы выдумкой на пустом месте.
   */
  it('без процента окна прогноза нет', () => {
    ingestFixtures()
    const config = structuredClone(DEFAULT_CONFIG)
    ensureLimitWindows(db, config.limits.claude)
    const report = limitsReport(db, Date.parse('2026-07-28T13:00:00.000Z'), config.limits.claude)

    const claude = report.windows.filter((window) => window.provider === 'claude')
    expect(claude).not.toHaveLength(0)
    expect(claude.every((window) => window.forecast === null)).toBe(true)
  })

  /**
   * Ловит перевёрнутое деление и потерянный «сбросится раньше». Потолка в
   * токенах нет ни у одного провайдера, поэтому остаток считается через цену
   * процента: сколько токенов мы насчитали за окно на каждый его процент.
   * Проверяется в обе стороны — растёт темп, падает время до упора, — и то,
   * что упор дальше сброса окна упором не называется.
   */
  it('считает время до упора по цене процента и отличает сброс от упора', () => {
    ingestFixtures()
    const config = structuredClone(DEFAULT_CONFIG)
    ensureLimitWindows(db, config.limits.claude)

    const codex = readLimitWindows(db).find(
      (window) => window.provider === 'codex' && (window.usedPercent ?? 0) > 0,
    )!
    const at = codex.startsAt + 600_000
    // Расход сессии переносится внутрь окна: у фикстуры Codex запросы и окно
    // приезжают из одного файла, но на разных метках.
    db.run(
      `UPDATE requests SET ts = ?
       WHERE session_id IN (SELECT id FROM sessions WHERE provider = 'codex')`,
      at - 120_000,
    )

    const window = limitsReport(db, at, config.limits.claude, 300_000).windows.find(
      (row) => row.provider === 'codex' && row.startsAt === codex.startsAt,
    )!
    const forecast = window.forecast!

    expect(forecast.tokensPerMinute).toBeGreaterThan(0)
    // Цена процента × остаток процентов ÷ темп — то же число, посчитанное иначе.
    const spent = db.get<{ tokens: number }>(
      `SELECT sum(input + output + cache_write + cache_read) AS tokens FROM requests
       JOIN sessions ON sessions.id = requests.session_id WHERE sessions.provider = 'codex'`,
    )!.tokens
    expect(forecast.minutesToCap).toBe(
      Math.round(
        ((spent / window.usedPercent!) * (100 - window.usedPercent!)) / forecast.tokensPerMinute,
      ),
    )
    expect(forecast.resetsFirst).toBe(forecast.minutesToCap! * 60_000 > window.resetsAt - at)

    // Тот же расход, размазанный вдвое дольше, — вдвое медленнее и вдвое
    // дальше до упора.
    const slower = limitsReport(db, at, config.limits.claude, 600_000).windows.find(
      (row) => row.provider === 'codex' && row.startsAt === codex.startsAt,
    )!.forecast!
    expect(slower.tokensPerMinute).toBeLessThan(forecast.tokensPerMinute)
    expect(slower.minutesToCap!).toBeGreaterThan(forecast.minutesToCap!)
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
