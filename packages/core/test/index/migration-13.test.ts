/**
 * `is_error` и голова ответа сабагента в индексе (9.1) и миграция 13.
 *
 * Эталон — `fixtures/claude/sidechain.*`: три транскрипта, у которых статусы
 * вызовов и голова выписаны руками (`*.expected.json`). Здесь проверяется то,
 * чего парсер не видит: что значения доехали до колонок и что `NULL` остался
 * `NULL`, а не стал нулём.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, type SourceFile } from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'
import { SCHEMA_VERSION } from '../../src/index/schema.ts'

const claudeDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const subagentsDir = join(claudeDir, 'sidechain.subagents')

const REAL = 'agent-a6bf337b0067775dd'
const HANDMADE = 'agent-a7e3c19d04b5f2681'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-migration-13-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function subagent(path: string): SourceFile {
  return {
    path,
    provider: 'claude',
    kind: 'subagent',
    parentPath: join(claudeDir, '92cc27dc-193d-4c2c-aef1-843d7d41aeab.jsonl'),
  }
}

/** Голова из ручного расчёта, а не из вывода парсера. */
function expectedHead(name: string): string | null {
  const expected = JSON.parse(
    readFileSync(join(subagentsDir, `${name}.expected.json`), 'utf8'),
  ) as {
    session: { lastTextHead: string | null }
  }
  return expected.session.lastTextHead
}

function toolStatuses(sessionId: string): Array<number | null> {
  return db
    .all<{ is_error: number | null }>(
      'SELECT is_error FROM tool_calls WHERE session_id = ? ORDER BY seq, idx',
      sessionId,
    )
    .map((row) => row.is_error)
}

describe('is_error и голова в индексе', () => {
  beforeEach(() => {
    for (const file of [
      { path: join(claudeDir, 'sidechain.jsonl'), provider: 'claude', kind: 'session' },
      subagent(join(subagentsDir, `${REAL}.jsonl`)),
      subagent(join(subagentsDir, `${HANDMADE}.jsonl`)),
      { path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' },
    ] as SourceFile[]) {
      expect(ingestFile(db, file).parsed).toBe(true)
    }
  })

  /**
   * Пять ошибок, 95 успехов и 2 «не знаем» — сумма трёх ручных эталонов
   * (корень 1/11/0, реальный сабагент 3/82/0, написанный руками 1/2/2). Если
   * «не знаем» ляжет нулём, оно станет успехом; если «ключа нет» ляжет `NULL`,
   * 61 успех уйдёт из знаменателя, и доля ошибок вырастет вдвое (правило 30).
   */
  it('1, 0 и NULL ложатся в колонку как есть', () => {
    const rows = db.all<{ status: string; n: number }>(
      `SELECT coalesce(CAST(is_error AS TEXT), 'null') AS status, count(*) AS n
       FROM tool_calls JOIN sessions ON sessions.id = tool_calls.session_id
       WHERE sessions.provider = 'claude' GROUP BY 1 ORDER BY 1`,
    )

    expect(rows).toEqual([
      { status: '0', n: 95 },
      { status: '1', n: 5 },
      { status: 'null', n: 2 },
    ])
  })

  it('статусы написанного руками сабагента: true, false, false, null, null', () => {
    expect(toolStatuses(HANDMADE.replace('agent-', ''))).toEqual([1, 0, 0, null, null])
  })

  it('у Codex is_error пуст у каждого вызова', () => {
    const rows = db.all<{ calls: number; known: number }>(
      `SELECT count(*) AS calls, count(is_error) AS known
       FROM tool_calls JOIN sessions ON sessions.id = tool_calls.session_id
       WHERE sessions.provider = 'codex'`,
    )

    expect(rows[0]!.calls).toBeGreaterThan(0)
    expect(rows[0]!.known).toBe(0)
  })

  it('голова — у сабагентов, у корня и у Codex NULL', () => {
    const heads = db.all<{ id: string; provider: string; sidechain: number; head: string | null }>(
      `SELECT id, provider, is_sidechain AS sidechain, last_text_head AS head FROM sessions
       ORDER BY provider, id`,
    )

    const handmade = heads.find((row) => row.id === HANDMADE.replace('agent-', ''))!
    const real = heads.find((row) => row.id === REAL.replace('agent-', ''))!
    expect(handmade.head).toBe(expectedHead(HANDMADE))
    expect(real.head).toBe(expectedHead(REAL))
    expect(Array.from(real.head!)).toHaveLength(200)
    expect(
      heads.filter((row) => row.sidechain === 0).map((row) => [row.provider, row.head]),
    ).toEqual([
      ['claude', null],
      ['codex', null],
    ])
  })
})

describe('миграция 13 — дочитать без сноса', () => {
  const lying = (): string => join(dir, `${HANDMADE}.jsonl`)
  const gone = (): string => join(dir, `${REAL}.jsonl`)

  /**
   * Снос базы, как в 11, стёр бы сессии пропавших логов, которые правило 19
   * обещало помнить. Миграция добавляет два столбца и сбрасывает `offset` —
   * файлы, которые проход найдёт, он перечитает; пропавшие остаются с `NULL`,
   * и это правда: логов нет, мерить нечем. Помеченный пропавшим, но лежащий на
   * диске файл (на копии живого индекса таких 197) тоже перечитывается — иначе
   * совпавшая четвёрка оставила бы его без статусов и головы навсегда.
   */
  it('найденные файлы перечитываются, пропавшие остаются в базе с NULL', () => {
    copyFileSync(join(subagentsDir, `${HANDMADE}.jsonl`), lying())
    copyFileSync(join(subagentsDir, `${REAL}.jsonl`), gone())
    expect(ingestFile(db, subagent(lying())).parsed).toBe(true)
    expect(ingestFile(db, subagent(gone())).parsed).toBe(true)
    const before = db.get<{ requests: number; calls: number }>(
      `SELECT (SELECT count(*) FROM requests WHERE session_id = 'a6bf337b0067775dd') AS requests,
              (SELECT count(*) FROM tool_calls WHERE session_id = 'a6bf337b0067775dd') AS calls`,
    )!

    // Индекс версии 12: столбцов нет; один лог пропал с диска, другой помечен
    // пропавшим, хотя лежит на месте.
    db.run('UPDATE sources SET vanished_at = 1')
    rmSync(gone())
    db.exec('ALTER TABLE tool_calls DROP COLUMN is_error')
    db.exec('ALTER TABLE sessions DROP COLUMN last_text_head')
    db.run('UPDATE meta SET value = ? WHERE key = ?', '12', 'schema_version')
    db.close()

    const reopened = openDb(join(dir, 'index.sqlite'))
    db = reopened.db
    expect(reopened.rebuilt).toBe(false)
    // Тест написан на версии 13: сдвинулась схема — симуляцию старого индекса
    // ниже пересмотреть (дальше её миграции тоже сработают при открытии).
    expect(SCHEMA_VERSION).toBe(13)
    expect(
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version'),
    ).toEqual({ value: '13' })
    expect(db.all<{ offset: number }>('SELECT offset FROM sources')).toEqual([
      { offset: 0 },
      { offset: 0 },
    ])

    // Следующий проход: лежащий файл перечитан — статусы и голова появились,
    // пометка снята.
    expect(ingestFile(db, subagent(lying())).parsed).toBe(true)
    expect(toolStatuses('a7e3c19d04b5f2681')).toEqual([1, 0, 0, null, null])
    expect(
      db.get('SELECT last_text_head AS head FROM sessions WHERE id = ?', 'a7e3c19d04b5f2681'),
    ).toEqual({ head: expectedHead(HANDMADE) })
    expect(db.get('SELECT vanished_at FROM sources WHERE path = ?', lying())).toEqual({
      vanished_at: null,
    })

    // Сессия пропавшего лога на месте — со всеми запросами и вызовами, но без
    // статусов и головы, и пометка при ней осталась.
    expect(
      db.get(
        `SELECT (SELECT count(*) FROM requests WHERE session_id = 'a6bf337b0067775dd') AS requests,
                (SELECT count(*) FROM tool_calls WHERE session_id = 'a6bf337b0067775dd') AS calls`,
      ),
    ).toEqual(before)
    expect(toolStatuses('a6bf337b0067775dd').every((status) => status === null)).toBe(true)
    expect(
      db.get('SELECT last_text_head AS head FROM sessions WHERE id = ?', 'a6bf337b0067775dd'),
    ).toEqual({ head: null })
    expect(db.get('SELECT vanished_at FROM sources WHERE path = ?', gone())).toEqual({
      vanished_at: 1,
    })
  })

  /**
   * Миграции 12 и 13 идут подряд, когда индекс старше обеих: оба `ALTER`
   * применяются, сброс `offset` стоит дважды и ничему не мешает.
   */
  it('индекс версии 11 доходит до 13 без сноса', () => {
    db.exec('ALTER TABLE requests DROP COLUMN duration_ms')
    db.exec('ALTER TABLE tool_calls DROP COLUMN is_error')
    db.exec('ALTER TABLE sessions DROP COLUMN last_text_head')
    db.run('UPDATE meta SET value = ? WHERE key = ?', '11', 'schema_version')
    db.close()

    const reopened = openDb(join(dir, 'index.sqlite'))
    db = reopened.db

    expect(reopened.rebuilt).toBe(false)
    expect(
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version'),
    ).toEqual({ value: String(SCHEMA_VERSION) })
    for (const [table, column] of [
      ['requests', 'duration_ms'],
      ['tool_calls', 'is_error'],
      ['sessions', 'last_text_head'],
    ] as const) {
      expect(
        db
          .all<{ name: string }>(`PRAGMA table_info(${table})`)
          .some((info) => info.name === column),
        `${table}.${column}`,
      ).toBe(true)
    }
  })
})
