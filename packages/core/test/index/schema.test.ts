import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/index/db.ts'
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/index/schema.ts'

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

  // Версия 4 — первая миграция с rebuild, и до неё эта ветка openDb не
  // выполнялась ни разу. Проверяется именно она: снос базы под открытым
  // соединением, с включёнными внешними ключами и данными во всех таблицах.
  it.each([1, 2, 3])('индекс версии %i пересобирается, а не чинится по кусочкам', (version) => {
    const first = openDb(dbPath())
    seedMigrationData(first.db)
    first.db.run('UPDATE meta SET value = ? WHERE key = ?', String(version), 'schema_version')
    first.db.close()

    const { db, rebuilt } = openDb(dbPath())
    // rebuilt = true — обещание вызывающему перечитать логи. Отдать пустую
    // базу молча значит показать ноль вместо расхода.
    expect(rebuilt).toBe(true)
    expect(
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version'),
    ).toEqual({ value: String(SCHEMA_VERSION) })
    for (const table of ['sources', 'sessions', 'requests', 'tool_calls', 'diagnostics']) {
      expect(db.all(`SELECT * FROM ${table}`), table).toHaveLength(0)
    }
    // Пересборка гасит внешние ключи, чтобы снести таблицы в любом порядке.
    // Забыть их вернуть значит на весь сеанс остаться без каскадов — тихо, до
    // первого осиротевшего запроса.
    expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 })
    db.close()
  })

  it('список миграций доводит ровно до текущей версии', () => {
    const versions = MIGRATIONS.map((migration) => migration.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(Math.max(...versions)).toBe(SCHEMA_VERSION)
    for (const migration of MIGRATIONS) {
      expect(Boolean(migration.sql) !== Boolean(migration.rebuild), String(migration.version)).toBe(
        true,
      )
    }
  })
})

describe('лимиты в индексе', () => {
  it('процент окна законно пустой, а расход отличим от нуля', () => {
    const { db } = openDb(dbPath())
    db.run(
      `INSERT INTO limit_windows (
         provider, kind, window_minutes, starts_at, resets_at, used_percent, observed_at, exact
       ) VALUES ('claude', 'fiveHour', 300, 1000, 1000 + 300 * 60000, NULL, 2000, 0)`,
    )
    db.run(
      `INSERT INTO limit_windows (
         provider, kind, window_minutes, starts_at, resets_at, used_percent, observed_at, exact
       ) VALUES ('codex', 'weekly', 10080, 1000, 1000 + 10080 * 60000, 16.5, 2000, 1)`,
    )
    expect(
      db.all('SELECT provider, used_percent, usage_weighted FROM limit_windows ORDER BY provider'),
    ).toEqual([
      { provider: 'claude', used_percent: null, usage_weighted: null },
      { provider: 'codex', used_percent: 16.5, usage_weighted: null },
    ])
    db.close()
  })

  it('два окна с одним якорем не сливаются молча', () => {
    const { db } = openDb(dbPath())
    const insert = (percent: number) =>
      db.run(
        `INSERT INTO limit_windows (
           provider, kind, window_minutes, starts_at, resets_at, used_percent, observed_at, exact
         ) VALUES ('codex', 'fiveHour', 300, 1000, 1000 + 300 * 60000, ?, 2000, 1)`,
        percent,
      )
    insert(30)
    expect(() => insert(2)).toThrow()
    db.close()
  })

  it('наблюдения снимаются вместе с источником', () => {
    const { db } = openDb(dbPath())
    for (const ts of [1000, 2000]) {
      db.run(
        `INSERT INTO limit_observations (source_path, provider, ts, window_minutes, used_percent, resets_at)
         VALUES ('/rollout.jsonl', 'codex', ?, 300, 12, 99000)`,
        ts,
      )
    }
    // Один и тот же слот в одну и ту же секунду — не ошибка: Codex пишет
    // `token_count` дважды на запрос. Сборка окон берёт максимум, поэтому
    // дубль безвреден, а вот отказ вставки уронил бы ingest на живых логах.
    db.run(
      `INSERT INTO limit_observations (source_path, provider, ts, window_minutes, used_percent, resets_at)
       VALUES ('/rollout.jsonl', 'codex', 1000, 300, 12, 99000)`,
    )
    expect(db.all('SELECT * FROM limit_observations')).toHaveLength(3)
    db.run('DELETE FROM limit_observations WHERE source_path = ?', '/rollout.jsonl')
    expect(db.all('SELECT * FROM limit_observations')).toHaveLength(0)
    db.close()
  })
})

function seedMigrationData(db: ReturnType<typeof openDb>['db']): void {
  db.run(
    `INSERT INTO sources (path, provider, inode, size, mtime, offset, parsed_at)
     VALUES ('/migration.jsonl', 'claude', 1, 2, 3, 2, 4)`,
  )
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
  db.run(
    `INSERT INTO diagnostics (source_path, kind, detail, count, cli_version, seen_at)
     VALUES ('/migration.jsonl', 'unknown_record_type', 'queue-operation', 12, '2.1.220', 5)`,
  )
}
