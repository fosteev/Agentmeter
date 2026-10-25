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

export const SCHEMA_VERSION = 13

/**
 * `sources` — что уже прочитано. Ключ дочитывания это тройка
 * (path, inode, offset): путь один и тот же, а inode меняется при ротации
 * файла, и тогда offset надо обнулить, иначе индекс будет читать чужие байты.
 * Уменьшение размера файла — тот же признак: файл обрезали.
 *
 * `vanished_at` — когда файла не стало на диске. Строка при этом остаётся, и
 * разобранные из неё сессии тоже: Claude Code удаляет свои транскрипты сам
 * (`cleanupPeriodDays`, по умолчанию 30 дней), и с этого момента индекс —
 * единственная запись о том расходе. Подробности — «Ретеншн индекса» в
 * `docs/roadmap.md`.
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
  parsed_at  INTEGER NOT NULL,
  vanished_at INTEGER
) STRICT;

-- sessions.last_text_head (9.1) — первые 200 кодпоинтов последнего текстового
-- блока сабагента, сырой текст: вердикт из него считается при запросе. NULL у
-- корневых сессий, у Codex, у сабагента без текста и у сессий, чей лог пропал
-- раньше, чем его успели перечитать версией 13: «не знаем», а не пустая строка.
-- Описание стоит здесь, а не внутри таблицы, нарочно: кириллический комментарий
-- перед последним столбцом ломает SQLite DROP COLUMN на части текстов
-- («incomplete input»), а тесты миграций собирают старый индекс именно им.
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
  is_sidechain       INTEGER NOT NULL DEFAULT 0,
  -- Стартовый префикс: сколько токенов лежало в промпте до первого ответа (1.7).
  -- Ноль — законное значение и означает «записанных запросов в файле нет»: на
  -- живых логах таких сессий 38 из 617, и расхода на них ровно ноль.
  prefix_tokens      INTEGER NOT NULL DEFAULT 0,
  -- В наборе был ToolSearch. Без этого признака совет «отключи сервер» врёт
  -- на порядок: схемы MCP в отложенном режиме в префикс не едут вовсе.
  tools_deferred     INTEGER NOT NULL DEFAULT 0,
  last_text_head     TEXT
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
  -- Сколько ждали ответ, мс (8.4). NULL — мерить нечем: восстановленный запрос,
  -- нет записи-старта, конец по метке не позже начала, или лог пропал раньше,
  -- чем его успели перечитать версией 12. Ноль здесь не пишется никогда.
  duration_ms    INTEGER,
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
  -- Результат вызова — ошибка (9.1): 1 — is_error true, 0 — false или ключа
  -- нет (в API он по умолчанию ложен; явный false Claude Code пишет только у
  -- Bash, правило 30), NULL — не знаем: результата нет, ключ не булев, Codex.
  -- Доля ошибок делится на вызовы с известным статусом, count(is_error).
  is_error        INTEGER,
  PRIMARY KEY (session_id, seq, idx),
  FOREIGN KEY (session_id, seq) REFERENCES requests (session_id, seq) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS tool_calls_name   ON tool_calls (name);
CREATE INDEX IF NOT EXISTS tool_calls_server ON tool_calls (server) WHERE server IS NOT NULL;

-- Файлы, которых коснулся вызов: путь плюс что с ним сделали (3.4).
--
-- Отдельная таблица, а не колонка в tool_calls, по одной причине: один
-- apply_patch правит несколько файлов сразу, и в колонку влез бы только
-- первый — молча, потому что «путь у вызова есть» выглядело бы правдой.
--
-- Путь лежит как его назвал источник. Приведение к виду «относительно проекта»
-- живёт в запросе: правило показа поменяется скорее, чем логи, а переиндексация
-- ради оформления — это перечитывание 570 МБ.
CREATE TABLE IF NOT EXISTS tool_files (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  path       TEXT    NOT NULL,
  -- read | write. Одинаково значит у обоих провайдеров только write: у Codex
  -- чтение идёт шеллом и в лог структурой не попадает вовсе (sources/files.ts).
  action     TEXT    NOT NULL,
  -- Путь в ключе: патч, дважды назвавший один файл (Update File + Move to
  -- обратно), — это один затронутый файл, а не два.
  PRIMARY KEY (session_id, seq, idx, path),
  FOREIGN KEY (session_id, seq, idx) REFERENCES tool_calls (session_id, seq, idx) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS tool_files_session ON tool_files (session_id, action);
CREATE INDEX IF NOT EXISTS tool_files_path    ON tool_files (path);

-- Раскладка стартового префикса по категориям (1.7), из которой 4.1 собирает
-- постоянный расход дня: цена блока умножается на число запросов сессии.
--
-- Порядковый номер в ключе, а не (категория, источник): у Codex system —
-- измеренный блок, а toolSchemas — остаток, и однажды остаток и оценка одной
-- категории окажутся рядом. NULL в составном ключе SQLite считает различными
-- значениями, то есть уникальность по (category, source) не удержала бы ничего
-- и промолчала бы об этом.
CREATE TABLE IF NOT EXISTS prefix_blocks (
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  category   TEXT    NOT NULL,
  -- Имя MCP-сервера. По нему 4.3 считает экономию от выключения.
  source     TEXT,
  bytes      INTEGER NOT NULL,
  tokens     INTEGER NOT NULL,
  -- Сколько штук в статье: скиллов и сабагентов в листинге, тулов у сервера,
  -- файлов памяти (4.2). У остатка ноль — системный промпт не состоит из
  -- перечислимых штук, и единица здесь означала бы «одна штука».
  items      INTEGER NOT NULL DEFAULT 0,
  -- estimated — посчитано по байтам, residual — измеренный остаток. Разные
  -- вещи: остаток нельзя посоветовать выключить, он и есть системный промпт.
  basis      TEXT    NOT NULL,
  PRIMARY KEY (session_id, idx)
) STRICT;

CREATE INDEX IF NOT EXISTS prefix_blocks_category ON prefix_blocks (category);

-- Состав блока поимённо (4.9): скиллы, сабагенты, отложенные тулы, файлы
-- памяти. Отдельной таблицей, а не списком в строке блока: подсказка спрашивает
-- «в скольких сессиях периода лежал вот этот скилл», и это group by по имени, а
-- не разбор JSON в каждой строке.
--
-- Строк нет вовсе там, где источник имён не назвал, и это не то же самое, что
-- ноль штук: у Codex память приезжает безымянными блоками, у остатка
-- перечислимых штук не существует. Различить два случая можно только
-- отсутствием строк против items = 0 в самом блоке.
--
-- Имя файла памяти здесь абсолютное. displayPath из лога относителен рабочему
-- каталогу, и один и тот же CLAUDE.md записан в разных сессиях тремя строками —
-- склейка по нему сделала бы из одного файла три.
CREATE TABLE IF NOT EXISTS prefix_items (
  session_id TEXT    NOT NULL,
  -- Номер блока в prefix_blocks. Категория и источник берутся из него же:
  -- второй раз записанные, они разъехались бы с блоком на первой правке.
  idx        INTEGER NOT NULL,
  -- Порядок внутри блока — тот же, что в логе. Не сортировка показа: она
  -- по охвату и живёт в запросе.
  ord        INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  PRIMARY KEY (session_id, idx, ord),
  FOREIGN KEY (session_id, idx) REFERENCES prefix_blocks (session_id, idx) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS prefix_items_name ON prefix_items (name);

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
  {
    // Появилась `tool_files` (3.4). ALTER-ом её не наполнить: пути лежат только
    // в логах, а старая база помнит эти файлы разобранными и дочитывать их не
    // станет — таблица осталась бы пустой навсегда. Пустая при этом читается
    // как «задача не тронула ни одного файла», то есть та же ложь, что в
    // миграции 4. Перечитывание стоит 2.8 с холодного прохода.
    version: 5,
    rebuild: true,
  },
  {
    // `HEAD` перестал считаться веткой (3.7). Правка живёт в парсере, а в
    // старой базе `branch` уже записан — и `UPDATE ... SET branch = NULL`
    // сюда не годится: он вылечит сегодняшний признак и промолчит про
    // завтрашний. Индекс производен от логов целиком, и единственный способ
    // получить его таким, каким его собирает нынешний парсер, — перечитать.
    version: 6,
    rebuild: true,
  },
  {
    // Появились `prefix_blocks` и два столбца сессии (4.1). Раскладка префикса
    // до этой версии не хранилась вовсе — она считалась при разборе и жила
    // только в памяти парсера. Долить её ALTER-ом неоткуда: старая база помнит
    // файлы разобранными и дочитывать их не станет, а пустая таблица читается
    // как «префикса не было», то есть «постоянный расход равен нулю» — ровно то
    // утверждение, которое 3.0 запретил делать нулями.
    version: 7,
    rebuild: true,
  },
  {
    // У блоков префикса появилось число штук (4.2). Столбец с DEFAULT долить
    // можно, а вот значения — неоткуда: они считаются из листингов в логах, и
    // старая база помнит эти файлы разобранными. Ноль во всех строках читался
    // бы как «скиллов ноль», то есть «загружено ничего» — а на этом числе
    // стоит вся правая колонка «использовано» и весь совет 4.3.
    version: 8,
    rebuild: true,
  },
  {
    // `compacted` сменил смысл (4.4): компакт — это обвал контекста, а не обвал
    // кэша. Прежнее правило называло компактом истёкший кэш и ошибалось на
    // живых логах в 90 случаях из 91. Правка живёт в парсере, а в старой базе
    // флаг уже записан — и `UPDATE` сюда не годится ровно по той же причине,
    // что в миграции 6 про `HEAD`: он вылечит сегодняшние строки и промолчит
    // про завтрашние. Индекс производен от логов целиком.
    version: 9,
    rebuild: true,
  },
  {
    // Первая совместимая миграция с версии 3, и это не случайность: столбец
    // добавляется ради того, чего в логах нет и не будет, — момента, когда лога
    // не стало. Перечитывать нечего, а старым строкам `NULL` подходит по
    // смыслу: файлы, лежащие на диске, не пропадали. Пропавшие до этой версии
    // индекс уже забыл, и вернуть их неоткуда — так и записано в «Ретеншн
    // индекса».
    version: 10,
    sql: 'ALTER TABLE sources ADD COLUMN vanished_at INTEGER;',
  },
  {
    // Появилась `prefix_items` (4.9). Пустая таблица читается как «состав не
    // назван» — фраза, которую экран показывает у Codex и у остатка, — то есть
    // ALTER без перечитывания соврал бы про **каждую** статью сразу, и соврал
    // бы связно. Заодно этой версией чинится число штук у скиллов: до 4.9 оно
    // считалось регуляркой, а та видит только форму `- имя: описание` и в
    // худшей сессии давала 12 вместо 36. Старые строки счёт не пересчитают —
    // листинги лежат только в логах.
    version: 11,
    rebuild: true,
  },
  {
    // Время ответа на запросе (8.4) — и первая миграция, которая **дочитывает
    // без сноса**. Значения лежат только в логах, как в 4–9 и 11, но снос
    // базы теперь стоит дороже перечитывания: с версии 10 индекс помнит
    // сессии пропавших логов (правило 19), и `rebuild` стёр бы их навсегда.
    //
    // Поэтому столбец добавляется ALTER-ом, а источникам сбрасывается
    // `offset`: проход сравнивает четвёрку inode/size/mtime/offset
    // (`ingest.ts`), видит несовпадение и перечитывает файл, а `putSession`
    // заменяет его сессию целиком по `source_path`. Пропавшие остаются как
    // были, с `NULL` во времени, — и это правда: логов нет, мерить нечем.
    // Тот же механизм нужен 9.1 (схема 13).
    //
    // Сброс — у **всех** источников, а не только у `vanished_at IS NULL`:
    // пропавший файл проход не находит и `offset` его не читает, так что
    // вреда нет, а вот помеченных пропавшими файлов, которые на диске есть,
    // на копии живого индекса нашлось 197 из 809. Проход их пропускает по
    // совпавшей четвёрке, не снимая пометки, и без сброса они остались бы
    // без времени навсегда, хотя мерить есть чем.
    version: 12,
    sql: `ALTER TABLE requests ADD COLUMN duration_ms INTEGER;
UPDATE sources SET offset = 0;`,
  },
  {
    // Статус вызова и голова последнего ответа сабагента (9.1) — вторая
    // миграция, что **дочитывает без сноса**, тем же способом, что 12. Значения
    // лежат только в логах, и `rebuild` стёр бы сессии пропавших логов
    // (правило 19), поэтому два столбца добавляются ALTER-ом, а источникам
    // сбрасывается `offset`: проход видит несовпадение четвёрки и перечитывает
    // файл, `putSession` заменяет его сессию целиком. Пропавшие остаются как
    // были, с `NULL` в обеих колонках, — и это правда: логов нет, мерить нечем.
    //
    // Сброс — у **всех** источников, как в 12, а не у `vanished_at IS NULL`:
    // помеченные пропавшими, но лежащие на диске файлы (на копии живого индекса
    // их 197 из 809) проход пропускает по совпавшей четвёрке, и без сброса они
    // остались бы без статусов и головы навсегда. Индекс версии 11 проходит обе
    // миграции подряд — сброс стоит дважды и ничему не мешает.
    version: 13,
    sql: `ALTER TABLE tool_calls ADD COLUMN is_error INTEGER;
ALTER TABLE sessions ADD COLUMN last_text_head TEXT;
UPDATE sources SET offset = 0;`,
  },
]
