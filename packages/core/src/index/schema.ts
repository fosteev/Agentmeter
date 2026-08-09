/**
 * Схема индекса и правила её изменения.
 *
 * Главное свойство индекса: он **полностью производен от логов**. Ни одна
 * цифра здесь не существует только в базе — всё пересчитывается из
 * `~/.claude/projects/**` и `~/.codex/sessions/**` за один проход. Отсюда
 * дешёвая миграция: если новая версия схемы несовместима со старой, базу
 * сносим и перечитываем логи, а не сочиняем ALTER TABLE на все случаи.
 *
 * Правила:
 * 1. `SCHEMA_VERSION` растёт при любом изменении структуры.
 * 2. Совместимое изменение (новая таблица, новый индекс, колонка с DEFAULT) —
 *    добавляется миграцией в `MIGRATIONS`.
 * 3. Несовместимое — миграция `{ rebuild: true }`: база пересоздаётся, логи
 *    перечитываются. Это медленно (холодный проход 570 МБ), но честно.
 * 4. Пользовательских данных в индексе нет. Настройки живут в конфиге (0.5),
 *    и снос базы их не трогает.
 */

export const SCHEMA_VERSION = 3

/**
 * `sources` — что уже прочитано. Ключ дочитывания это тройка
 * (path, inode, offset): путь один и тот же, а inode меняется при ротации
 * файла, и тогда offset надо обнулить, иначе индекс будет читать чужие байты.
 * Уменьшение размера файла — тот же признак: файл обрезали.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  path       TEXT PRIMARY KEY,
  provider   TEXT    NOT NULL,
  session_id TEXT,
  inode      INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  offset     INTEGER NOT NULL DEFAULT 0,
  parsed_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  provider           TEXT    NOT NULL,
  source_path        TEXT    NOT NULL,
  cwd                TEXT    NOT NULL,
  project            TEXT    NOT NULL,
  branch             TEXT,
  model              TEXT,
  entrypoint         TEXT,
  cli_version        TEXT,
  title              TEXT,
  first_prompt       TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER NOT NULL,
  parent_session_id  TEXT,
  parent_tool_use_id TEXT,
  agent_type         TEXT,
  is_sidechain       INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project, started_at);
CREATE INDEX IF NOT EXISTS sessions_parent  ON sessions (parent_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_source ON sessions (source_path);

CREATE TABLE IF NOT EXISTS requests (
  session_id     TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  request_id     TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  model          TEXT    NOT NULL,
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_write    INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  reasoning      INTEGER,
  cache_write_5m INTEGER,
  cache_write_1h INTEGER,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  skill          TEXT,
  is_sidechain   INTEGER NOT NULL DEFAULT 0,
  compacted      INTEGER NOT NULL DEFAULT 0,
  synthetic      INTEGER NOT NULL DEFAULT 0,
  interjected_bytes INTEGER NOT NULL DEFAULT 0,
  origin         TEXT    NOT NULL DEFAULT 'log',
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS requests_ts    ON requests (ts);
CREATE INDEX IF NOT EXISTS requests_model ON requests (model, ts);
CREATE INDEX IF NOT EXISTS requests_skill ON requests (skill) WHERE skill IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_calls (
  session_id      TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  idx             INTEGER NOT NULL,
  tool_use_id     TEXT,
  name            TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  server          TEXT,
  result_bytes    INTEGER NOT NULL DEFAULT 0,
  marginal_tokens INTEGER NOT NULL DEFAULT 0,
  marginal_basis  TEXT    NOT NULL DEFAULT 'unknown',
  has_image       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq, idx),
  FOREIGN KEY (session_id, seq) REFERENCES requests (session_id, seq) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS tool_calls_name   ON tool_calls (name);
CREATE INDEX IF NOT EXISTS tool_calls_server ON tool_calls (server) WHERE server IS NOT NULL;

-- Окна лимитов: у Codex приходят точными в логе, у Claude считаются нами и
-- всегда помечены exact = 0. Хранится история, а не только последнее
-- состояние: по ней видно, когда упирались в потолок.
CREATE TABLE IF NOT EXISTS limit_windows (
  provider       TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  observed_at    INTEGER NOT NULL,
  used_percent   REAL    NOT NULL,
  window_minutes INTEGER NOT NULL,
  resets_at      INTEGER,
  exact          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, kind, observed_at)
) STRICT;

-- Что парсер не понял: незнакомые типы записей и битые строки, с версией CLI.
-- Отсюда команда doctor берёт свой отчёт (1.4).
CREATE TABLE IF NOT EXISTS diagnostics (
  source_path TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  cli_version TEXT,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (source_path, kind, detail)
) STRICT;
`

export interface Migration {
  version: number
  /** Пересобрать индекс с нуля вместо переливки данных. */
  rebuild?: boolean
  sql?: string
}

/**
 * Миграции применяются по возрастанию версии, каждая в своей транзакции.
 * Версия 1 — начальная схема, отдельной миграцией не описывается.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS sessions_source ON sessions (source_path);',
  },
  {
    version: 3,
    sql: `ALTER TABLE tool_calls ADD COLUMN marginal_basis TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE requests ADD COLUMN interjected_bytes INTEGER NOT NULL DEFAULT 0;`,
  },
]
