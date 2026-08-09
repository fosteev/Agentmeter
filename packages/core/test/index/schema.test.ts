import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/index/db.ts'
import { SCHEMA_VERSION } from '../../src/index/schema.ts'

let dir: string
const dbPath = () => join(dir, 'index.sqlite')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('схема индекса', () => {
  it('создаётся с нуля и сообщает, что база пустая', () => {
    const { db, rebuilt } = openDb(dbPath())
    expect(rebuilt).toBe(true)
    expect(
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version'),
    ).toEqual({ value: String(SCHEMA_VERSION) })
    db.close()
  })

  it('повторное открытие не пересоздаёт индекс', () => {
    openDb(dbPath()).db.close()
    const { db, rebuilt } = openDb(dbPath())
    expect(rebuilt).toBe(false)
    db.close()
  })

  it('отказывается открывать базу от более новой версии', () => {
    const { db } = openDb(dbPath())
    db.run('UPDATE meta SET value = ? WHERE key = ?', String(SCHEMA_VERSION + 1), 'schema_version')
    db.close()
    expect(() => openDb(dbPath())).toThrow(/обновите приложение/)
  })

  it('удаление сессии уносит её запросы и тул-коллы', () => {
    const { db } = openDb(dbPath())
    db.transaction(() => {
      db.run(
        `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at)
         VALUES ('s1', 'claude', '/log.jsonl', '/proj/a', 'a', 1, 2)`,
      )
      db.run(
        `INSERT INTO requests (session_id, seq, request_id, ts, model)
         VALUES ('s1', 0, 'req_1', 1, 'claude-opus-5')`,
      )
      db.run(
        `INSERT INTO tool_calls (session_id, seq, idx, name, kind)
         VALUES ('s1', 0, 0, 'Bash', 'builtin')`,
      )
    })
    db.run('DELETE FROM sessions WHERE id = ?', 's1')
    expect(db.all('SELECT * FROM requests')).toHaveLength(0)
    expect(db.all('SELECT * FROM tool_calls')).toHaveLength(0)
    db.close()
  })

  it('один и тот же запрос не задваивается при повторном разборе файла', () => {
    const { db } = openDb(dbPath())
    db.run(
      `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at)
       VALUES ('s1', 'claude', '/log.jsonl', '/proj/a', 'a', 1, 2)`,
    )
    const insert = () =>
      db.run(
        `INSERT OR REPLACE INTO requests (session_id, seq, request_id, ts, model, output)
         VALUES ('s1', 0, 'req_1', 1, 'claude-opus-5', 100)`,
      )
    insert()
    insert()
    expect(db.all('SELECT * FROM requests')).toHaveLength(1)
    db.close()
  })

  it('мигрирует версию 1 в 3 без rebuild и сохраняет данные', () => {
    const first = openDb(dbPath())
    seedMigrationData(first.db)
    first.db.run('DROP INDEX sessions_source')
    first.db.run('ALTER TABLE tool_calls DROP COLUMN marginal_basis')
    first.db.run('ALTER TABLE requests DROP COLUMN interjected_bytes')
    first.db.run('UPDATE meta SET value = ? WHERE key = ?', '1', 'schema_version')
    first.db.close()

    const { db, rebuilt } = openDb(dbPath())
    expectMigratedToCurrent(db, rebuilt)
    expect(
      db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_source'",
      ),
    ).toEqual({
      name: 'sessions_source',
    })
    db.close()
  })

  it('мигрирует версию 2 в 3 без rebuild и сохраняет данные', () => {
    const first = openDb(dbPath())
    seedMigrationData(first.db)
    first.db.run('ALTER TABLE tool_calls DROP COLUMN marginal_basis')
    first.db.run('ALTER TABLE requests DROP COLUMN interjected_bytes')
    first.db.run('UPDATE meta SET value = ? WHERE key = ?', '2', 'schema_version')
    first.db.close()

    const { db, rebuilt } = openDb(dbPath())
    expectMigratedToCurrent(db, rebuilt)
    db.close()
  })
})

function seedMigrationData(db: ReturnType<typeof openDb>['db']): void {
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at)
     VALUES ('migration-session', 'claude', '/migration.jsonl', '/proj/a', 'a', 1, 2)`,
  )
  db.run(
    `INSERT INTO requests (session_id, seq, request_id, ts, model, output, interjected_bytes)
     VALUES ('migration-session', 0, 'migration-request', 1, 'claude-opus-5', 42, 7)`,
  )
  db.run(
    `INSERT INTO tool_calls (
       session_id, seq, idx, name, kind, marginal_tokens, marginal_basis
     ) VALUES ('migration-session', 0, 0, 'Read', 'builtin', 13, 'measured')`,
  )
}

function expectMigratedToCurrent(db: ReturnType<typeof openDb>['db'], rebuilt: boolean): void {
  expect(rebuilt).toBe(false)
  expect(
    db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version'),
  ).toEqual({ value: String(SCHEMA_VERSION) })
  expect(
    db.all<{ name: string }>('PRAGMA table_info(requests)').map((column) => column.name),
  ).toContain('interjected_bytes')
  expect(
    db.all<{ name: string }>('PRAGMA table_info(tool_calls)').map((column) => column.name),
  ).toContain('marginal_basis')
  expect(
    db.get(
      'SELECT request_id, output, interjected_bytes FROM requests WHERE session_id = ?',
      'migration-session',
    ),
  ).toEqual({ request_id: 'migration-request', output: 42, interjected_bytes: 0 })
  expect(
    db.get(
      'SELECT name, marginal_tokens, marginal_basis FROM tool_calls WHERE session_id = ?',
      'migration-session',
    ),
  ).toEqual({ name: 'Read', marginal_tokens: 13, marginal_basis: 'unknown' })
}
