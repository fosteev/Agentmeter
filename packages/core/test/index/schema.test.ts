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
    expect(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version')).toEqual(
      { value: String(SCHEMA_VERSION) },
    )
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
})
