import { mkdtempSync, rmSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CSV_BOM,
  EXPORT_COLUMNS,
  exportRows,
  ingestFile,
  taskRows,
  toCsv,
  todayReport,
  type DayRange,
  type SourceFile,
} from '../src/index.ts'
import { openDb, type Db } from '../src/index/db.ts'

/**
 * Выгрузка (4.8).
 *
 * Проверки названы по поломке, которую ловят. Главных две: выгрузка обязана
 * совпасть с экраном до токена (иначе у продукта два ответа на один вопрос) и
 * обязана пережить запятую в названии задачи (иначе строка съезжает на колонку,
 * оставаясь валидным CSV).
 */

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-export-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('exportRows', () => {
  /**
   * Ловит вторую сборку «почти как лента». Выгрузка читается теми же
   * функциями, что экран, и разойдись они — увидеть это можно было бы только
   * сложив CSV в редакторе.
   */
  it('строки задач — те же, что в ленте, и до токена', () => {
    fixtures()

    const rows = exportRows(db, allTime, 'task')
    const tasks = taskRows(db, allTime)

    expect(rows).toHaveLength(tasks.length)
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(
      tasks.reduce((sum, task) => sum + task.totals.total, 0),
    )
    expect(rows.every((row) => row.input + row.output + row.cacheWrite + row.cacheRead === row.total)).toBe(
      true,
    )
  })

  /**
   * Ловит день, посчитанный вторым запросом: сумма дней обязана совпасть с
   * шапкой «Сегодня» за тот же период.
   */
  it('строки дней сходятся с итогом периода', () => {
    fixtures()

    const days = exportRows(db, allTime, 'day')
    const report = todayReport(db, allTime)

    expect(days.length).toBeGreaterThan(0)
    expect(days.reduce((sum, row) => sum + row.total, 0)).toBe(report.totals!.total)
    // Провайдер у строки дня пуст: их в дне несколько, и назвать один значило
    // бы приписать день тому, кто просто набрал больше.
    expect(days.every((row) => row.provider === '')).toBe(true)
  })

  /**
   * Ловит признак точности, потерянный при выгрузке. `≈` внутри числа делает
   * его текстом, поэтому он едет отдельной колонкой — и без неё человек
   * получает столбец, который выглядит измеренным целиком.
   */
  it('оценка едет отдельной колонкой, а не знаком внутри числа', () => {
    fixtures()

    const rows = exportRows(db, allTime, 'task')

    expect(EXPORT_COLUMNS).toContain('approximate')
    expect(rows.some((row) => row.approximate)).toBe(true)
    expect(rows.every((row) => Number.isInteger(row.total))).toBe(true)
  })

  /**
   * Ловит день без расхода, выгруженный строкой из нулей, и обход, идущий по
   * запрошенному периоду вместо наблюдаемого окна.
   *
   * Сеется руками: фикстуры лежат в соседних сутках подряд, дня без работы
   * между ними нет вовсе, и проверка на них была бы зелена при любом правиле.
   * Период при этом открыт с обеих сторон — обход от нуля дал бы двадцать тысяч
   * запросов к индексу.
   */
  it('день без расхода в выгрузку не попадает, а обход не идёт от нуля', () => {
    seedDay(Date.parse('2026-08-03T09:00:00.000Z'), 1000)
    seedDay(Date.parse('2026-08-06T09:00:00.000Z'), 2000)

    const started = performance.now()
    const days = exportRows(db, allTime, 'day')
    const ms = performance.now() - started

    expect(days.map((row) => row.total)).toEqual([1000, 2000])
    expect(ms).toBeLessThan(500)
  })
})

describe('toCsv', () => {
  /**
   * Ловит поле, не закавыченное по RFC 4180. Название задачи с запятой,
   * кавычкой или переводом строки съезжает на соседнюю колонку — и файл при
   * этом остаётся валидным CSV, то есть ошибка молчит.
   */
  it('запятая, кавычка и перевод строки не ломают колонки', () => {
    const csv = toCsv([
      row({ title: 'Закрыть M3: сабагенты, настройки', branch: 'feat/a"b', project: 'a\nb' }),
    ])
    const lines = csv.slice(CSV_BOM.length).split('\r\n')

    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','))
    expect(lines[1]).toContain('"Закрыть M3: сабагенты, настройки"')
    expect(lines[1]).toContain('"feat/a""b"')
    expect(csv).toContain('"a\nb"')
  })

  /**
   * Ловит потерянный BOM. Excel читает UTF-8 без него как однобайтовую
   * кодировку, и русские имена проектов превращаются в мусор — молча, потому
   * что файл при этом открывается.
   */
  it('файл начинается с BOM, а строки кончаются CRLF', () => {
    const csv = toCsv([row({})])

    // Проверяется сам знак, а не `startsWith(CSV_BOM)`: пустая строка —
    // префикс любой, и такая проверка переживала мутацию «выкинуть BOM».
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(CSV_BOM).toHaveLength(1)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.split('\r\n').filter((line) => line !== '')).toHaveLength(2)
  })

  /** Ловит логическое значение, выгруженное как `[object Object]` или пусто. */
  it('признак оценки выгружается словом, а не пустотой', () => {
    expect(toCsv([row({ approximate: true })])).toContain(',true')
    expect(toCsv([row({ approximate: false })])).toContain(',false')
  })
})

function row(parts: Partial<ReturnType<typeof base>>): ReturnType<typeof base> {
  return { ...base(), ...parts }
}

function base() {
  return {
    date: '2026-08-10',
    provider: 'claude',
    project: 'proj',
    branch: 'main',
    ticket: '',
    title: 'обычное название',
    startedAt: '2026-08-10T09:00:00.000Z',
    input: 1,
    output: 2,
    cacheWrite: 3,
    cacheRead: 4,
    total: 10,
    requests: 5,
    approximate: false,
  }
}

/** Один запрос в заданный момент — сутки без работы между ними нужны намеренно. */
function seedDay(ts: number, tokens: number): void {
  const id = `seed-${ts}`
  db.run(
    `INSERT INTO sources (path, provider, inode, size, mtime, offset, parsed_at)
     VALUES (?, 'claude', 1, 1, 1, 0, 1)`,
    `/tmp/${id}.jsonl`,
  )
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                           is_sidechain, prefix_tokens, tools_deferred)
     VALUES (?, 'claude', ?, '/tmp', 'seed', ?, ?, 0, 0, 0)`,
    id,
    `/tmp/${id}.jsonl`,
    ts,
    ts,
  )
  db.run(
    `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                           cache_write, cache_read, context_tokens, origin)
     VALUES (?, 0, ?, ?, 'seed-model', ?, 0, 0, 0, ?, 'log')`,
    id,
    `${id}#0`,
    ts,
    tokens,
    tokens,
  )
}

function fixtures(): void {
  for (const name of ['compact', 'images', 'mcp', 'parallel', 'plain', 'sidechain']) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
}

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}
