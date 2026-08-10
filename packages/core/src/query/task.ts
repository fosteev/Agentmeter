/**
 * Внутренности одной задачи: запросы по одному и вызовы инструментов к ним.
 *
 * Здесь только чтение. Ни одного суждения о том, какой запрос выделен и почему,
 * в этом файле нет — оно живёт в `apps/desktop/src/main/task.ts`, потому что
 * суждение превращается в текст, а текст — в перевод (3.8). Ядро отдаёт факты:
 * сколько стоил запрос, что в нём было, сколько байт вернул каждый вызов.
 *
 * **Задача — это дерево сессий, а не одна сессия.** `taskRows` сводит сабагентов
 * в корень (`findRoot`), и строка ленты показывает расход вместе с ними. Собери
 * карточку по одной сессии — и в шапке будет 276 запросов, а в таймлайне 240,
 * причём каждое число по себе останется настоящим. Поэтому дерево собирается
 * один раз (`taskSessions`) и дальше служит всем трём разрезам карточки:
 * таймлайну, инструментам и файлам.
 */
import type { Db, SqlValue } from '../index/db.ts'
import type { MarginalBasis } from '../sources/types.ts'
import { display } from './files.ts'
import type { DayRange } from './types.ts'

export interface TaskRequest {
  /** Чья это сессия: корневая или сабагента. Разные сессии, одна задача. */
  sessionId: string
  seq: number
  ts: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** Сумма четырёх видов — высота столбика таймлайна. */
  total: number
  /** Весь промпт запроса (`ctx`), из него виден рост контекста по ходу задачи. */
  contextTokens: number
  compacted: boolean
}

export interface TaskCall {
  sessionId: string
  seq: number
  idx: number
  name: string
  /**
   * Байты результата — измерены, в отличие от `marginalTokens` при дележе.
   * Именно по ним называется причина дорогого запроса: «чей результат был
   * больше» — это факт, а «чей вклад в промпт был больше» при `basis: 'split'`
   * получается делением одной дельты на несколько вызовов (1.6).
   */
  resultBytes: number
  marginalTokens: number
  basis: MarginalBasis
  hasImage: boolean
  /**
   * Пути, объявленные параметром вызова (3.4). Пусто — инструмент их не
   * объявляет: у Codex чтение идёт шеллом, и структуры под него в логе нет.
   *
   * Укорочены по каталогу сессии тем же правилом, что список изменённых файлов:
   * один и тот же файл в подсказке к столбику и в чипе под инструментами обязан
   * называться одинаково, иначе это два разных файла на одном экране.
   */
  paths: string[]
}

export interface TaskDetail {
  /** Корень и все его сабагенты — те сессии, из которых собрана задача. */
  sessions: string[]
  /** Запросы задачи по времени; при равном времени — по сессии и номеру. */
  requests: TaskRequest[]
  calls: TaskCall[]
}

/**
 * Корень и всё, что он породил.
 *
 * `UNION` вместо `UNION ALL` не ради красоты: цикл в `parent_session_id` (а он
 * возможен — идентичность сабагента у Claude берётся из имени файла, факт 4)
 * на `UNION ALL` дал бы бесконечную рекурсию, а так обход останавливается на
 * первом повторе.
 */
export function taskSessions(db: Db, rootId: string): string[] {
  return db
    .all<{ id: string }>(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM sessions WHERE id = ?
         UNION
         SELECT sessions.id FROM sessions JOIN tree ON sessions.parent_session_id = tree.id
       )
       SELECT id FROM tree ORDER BY id`,
      rootId,
    )
    .map((row) => row.id)
}

/**
 * Запросы и вызовы задачи, при желании суженные периодом.
 *
 * Период здесь тот же, что у ленты: задача, начатая до полуночи и кончившаяся
 * после, попадает в оба дня своими кусками, и карточка обязана показывать
 * ровно тот кусок, который показала свёрнутая строка. На живых логах таких
 * задач 32 из 578, и на них приходится 21.5% расхода — то есть это не редкий
 * случай, а каждая пятая цифра.
 */
export function taskDetail(db: Db, rootId: string, range?: DayRange): TaskDetail {
  const sessions = taskSessions(db, rootId)
  if (sessions.length === 0) return { sessions, requests: [], calls: [] }

  const cwd = db.get<{ cwd: string }>('SELECT cwd FROM sessions WHERE id = ?', rootId)?.cwd
  const filter = taskFilter(sessions, range)
  const requests = db
    .all<{
      session_id: string
      seq: number
      ts: number
      input: number
      output: number
      cache_write: number
      cache_read: number
      context_tokens: number
      compacted: number
    }>(
      `SELECT session_id, seq, ts, input, output, cache_write, cache_read,
              context_tokens, compacted
       FROM requests
       WHERE ${filter.sql}
       ORDER BY ts, session_id, seq`,
      ...filter.params,
    )
    .map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      input: row.input,
      output: row.output,
      cacheWrite: row.cache_write,
      cacheRead: row.cache_read,
      total: row.input + row.output + row.cache_write + row.cache_read,
      contextTokens: row.context_tokens,
      compacted: row.compacted === 1,
    }))

  const calls = db
    .all<{
      session_id: string
      seq: number
      idx: number
      name: string
      result_bytes: number
      marginal_tokens: number
      marginal_basis: MarginalBasis
      has_image: number
      paths: string | null
    }>(
      `SELECT tool_calls.session_id, tool_calls.seq, tool_calls.idx, tool_calls.name,
              tool_calls.result_bytes, tool_calls.marginal_tokens, tool_calls.marginal_basis,
              tool_calls.has_image,
              (SELECT group_concat(path, char(10)) FROM tool_files
                WHERE tool_files.session_id = tool_calls.session_id
                  AND tool_files.seq = tool_calls.seq
                  AND tool_files.idx = tool_calls.idx) AS paths
       FROM tool_calls
       JOIN requests ON requests.session_id = tool_calls.session_id
                    AND requests.seq = tool_calls.seq
       WHERE ${filter.sql}
       ORDER BY requests.ts, tool_calls.session_id, tool_calls.seq, tool_calls.idx`,
      ...filter.params,
    )
    .map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      idx: row.idx,
      name: row.name,
      resultBytes: row.result_bytes,
      marginalTokens: row.marginal_tokens,
      basis: row.marginal_basis,
      hasImage: row.has_image === 1,
      paths:
        row.paths === null || row.paths.length === 0
          ? []
          : row.paths.split('\n').map((path) => display(path, cwd)),
    }))

  return { sessions, requests, calls }
}

/**
 * Сужение «сессии задачи и, если задан, период».
 *
 * Список сессий разворачивается в плейсхолдеры, а не склеивается в строку:
 * идентификатор приходит из индекса, но подстановка чужого текста в SQL —
 * ошибка, которую замечают один раз и поздно.
 */
export function taskFilter(
  sessions: readonly string[],
  range?: DayRange,
): { sql: string; params: SqlValue[] } {
  // Пустой список — не пустое сужение: `IN ()` для SQLite синтаксическая
  // ошибка, а отсутствие условия отдало бы весь индекс за одну задачу.
  if (sessions.length === 0) return { sql: '1 = 0', params: [] }
  const holes = sessions.map(() => '?').join(', ')
  const params: SqlValue[] = [...sessions]
  let sql = `requests.session_id IN (${holes})`
  if (range !== undefined) {
    sql += ' AND requests.ts >= ? AND requests.ts < ?'
    params.push(range.from, range.to)
  }
  return { sql, params }
}
