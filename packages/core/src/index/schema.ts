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

export const SCHEMA_VERSION = 4

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

-- Наблюдения лимита из логов Codex: по строке на слот записи token_count.
-- В индексе лежит вход сборки, а не её результат, и вот почему: окно живёт
-- поперёк файлов. Лимит общий на аккаунт, одно пятичасовое окно размазано по
-- всем роллаутам этих пяти часов, а ingest идёт файл за файлом и видит только
-- кусок. Собрать окно при разборе одного файла нельзя в принципе.
--
-- Имени слота (primary/secondary) здесь нет намеренно: до Codex CLI 0.145.0
-- primary был пятичасовым, с 0.145.0 стал недельным. Вид окна выводится из
-- его длины, и window_minutes — единственный надёжный признак (1.8).
--
-- Привязка к файлу нужна ровно для одного: снять наблюдения вместе с
-- источником, когда файл исчез или перечитан. Как у diagnostics, внешнего
-- ключа нет — строка источника пишется последней в той же транзакции.
CREATE TABLE IF NOT EXISTS limit_observations (
  source_path    TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL,
  used_percent   REAL    NOT NULL,
  resets_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS limit_observations_source ON limit_observations (source_path);
CREATE INDEX IF NOT EXISTS limit_observations_window
  ON limit_observations (provider, window_minutes, ts);

-- Окна лимита: у Codex собраны из наблюдений выше, у Claude — из наших же
-- запросов, и тогда всегда exact = 0. Таблица целиком пересобирается после
-- ingest: окно не принадлежит файлу, дописать его по частям нельзя.
--
-- Ключ — якорь окна, а не момент наблюдения. Окно фиксировано первым запросом
-- после истечения предыдущего, и (provider, window_minutes, starts_at) —
-- это и есть его личность (1.8). INSERT без OR REPLACE намеренно: два
-- разных окна с одним якорем означают ошибку сборки, и слить их в одно значит
-- занизить расход молча.
CREATE TABLE IF NOT EXISTS limit_windows (
  provider       TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  window_minutes INTEGER NOT NULL,
  starts_at      INTEGER NOT NULL,
  resets_at      INTEGER NOT NULL,
  -- null — законное значение, а не «ноль»: у Claude нет потолка плана в
  -- конфиге либо не откалиброван вес cache_read (1.9). Доля от неизвестного
  -- потолка не существует, и ноль здесь был бы утверждением, которого мы не
  -- делали.
  used_percent   REAL,
  observed_at    INTEGER NOT NULL,
  exact          INTEGER NOT NULL DEFAULT 0,
  -- Расход окна. У Codex его нет — провайдер сообщает только процент, — и все
  -- шесть колонок остаются NULL. NULL значит «не считали», ноль значил бы
  -- «посчитали и вышло ноль».
  usage_input       INTEGER,
  usage_output      INTEGER,
  usage_cache_write INTEGER,
  usage_cache_read  INTEGER,
  usage_weighted    REAL,
  usage_requests    INTEGER,
  PRIMARY KEY (provider, window_minutes, starts_at)
) STRICT;

CREATE INDEX IF NOT EXISTS limit_windows_span ON limit_windows (provider, kind, starts_at);

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
  {
    // `limit_windows` переписана под якорь окна и расход, и рядом появилась
    // `limit_observations`, которой в индексе не было вовсе. Долить наблюдения
    // ALTER-ом неоткуда: они лежат только в логах, а старая база помнит эти
    // файлы разобранными и дочитывать их не станет. Пустая таблица при этом
    // выглядела бы как «лимитов нет» — ровно то враньё, против которого весь
    // продукт. Поэтому единственный честный путь — перечитать логи (правило 3).
    version: 4,
    rebuild: true,
  },
]
