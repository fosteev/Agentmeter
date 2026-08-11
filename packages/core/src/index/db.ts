/**
 * Тонкая обёртка над SQLite и применение схемы.
 *
 * Драйвер — встроенный `node:sqlite`: он есть в Node 22.5+, не требует
 * пересборки под каждую платформу и потому не тащит `electron-rebuild` в
 * упаковку (M5). Взамен API помечен экспериментальным, поэтому доступ к нему
 * идёт через интерфейс `Db` — если придётся уйти на `better-sqlite3`,
 * меняется один файл, а не весь пакет.
 */
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts'

export interface Db {
  exec(sql: string): void
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined
  run(sql: string, ...params: SqlValue[]): void
  transaction<T>(fn: () => T): T
  close(): void
}

export type SqlValue = string | number | bigint | null | Uint8Array

class NodeSqliteDb implements Db {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get db(): DatabaseSync {
    return this.#db
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  run(sql: string, ...params: SqlValue[]): void {
    this.db.prepare(sql).run(...params)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Открывает базу и доводит её до актуальной схемы.
 *
 * Возвращает `rebuilt: true`, если индекс пришлось создать заново — вызывающий
 * обязан после этого перечитать логи с нуля, иначе покажет пустоту вместо
 * данных. Молча отдать пустую базу нельзя: в измерительном продукте ноль,
 * который на самом деле «мы стёрли и не перечитали», — худший вид вранья.
 */
export function openDb(path: string): { db: Db; rebuilt: boolean } {
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA synchronous = NORMAL')
  const db = new NodeSqliteDb(raw)

  const hasMeta = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  )
  if (!hasMeta) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL)
      db.run(
        'INSERT INTO meta (key, value) VALUES (?, ?)',
        'schema_version',
        String(SCHEMA_VERSION),
      )
    })
    return { db, rebuilt: true }
  }

  const current = Number(
    db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version')?.value ?? 0,
  )
  if (current === SCHEMA_VERSION) return { db, rebuilt: false }
  if (current > SCHEMA_VERSION) {
    // Файл закрывается **до** исключения: на Windows открытый дескриптор
    // держит файл, и после отказа его нельзя ни удалить, ни переименовать —
    // человек, которому сказали «удалите индекс», сделать этого не может.
    db.close()
    // База от более новой версии приложения: её структуру мы не знаем.
    throw new Error(
      `индекс версии ${current}, а приложение понимает ${SCHEMA_VERSION} — обновите приложение или удалите индекс`,
    )
  }

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  )
  const needsRebuild = pending.some((m) => m.rebuild)
  if (needsRebuild) {
    // Ключи выключаются снаружи транзакции: внутри неё этот PRAGMA — no-op
    // (так устроен SQLite), и тогда DROP TABLE родителя ломает следующий DROP
    // ребёнка с «no such table». Транзакция при этом остаётся: снос и создание
    // схемы обязаны быть атомарны, иначе падение посередине оставит базу без
    // таблиц и с прежним номером версии.
    raw.exec('PRAGMA foreign_keys = OFF')
    try {
      db.transaction(() => {
        dropEverything(db)
        db.exec(SCHEMA_SQL)
        db.run(
          'INSERT INTO meta (key, value) VALUES (?, ?)',
          'schema_version',
          String(SCHEMA_VERSION),
        )
      })
    } finally {
      raw.exec('PRAGMA foreign_keys = ON')
    }
    return { db, rebuilt: true }
  }

  db.transaction(() => {
    for (const m of pending) if (m.sql) db.exec(m.sql)
    db.run('UPDATE meta SET value = ? WHERE key = ?', String(SCHEMA_VERSION), 'schema_version')
  })
  return { db, rebuilt: false }
}

function dropEverything(db: Db): void {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`)
}
