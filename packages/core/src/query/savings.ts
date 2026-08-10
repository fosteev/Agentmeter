/**
 * Что можно выключить и сколько это вернёт (4.3) — карточка из строк 986–998
 * макета.
 *
 * Совет здесь один и самый узкий из возможных: **сервер MCP, чьи описания ехали
 * в префикс каждой сессии, а звали его ноль раз**. Всё остальное, что лежит в
 * постоянном расходе, либо неотделимо от агента (остаток), либо не является
 * набором возможностей (файлы памяти, первая реплика), либо называется только
 * числом, а не именем: листинг скиллов мы умеем посчитать, но не разобрать по
 * штукам, и «выключите два скилла из сорока» — не совет, а загадка.
 *
 * Три вещи, без которых совет врёт:
 *
 * 1. **Режим отложенных тулов.** Когда в наборе есть `ToolSearch`, в префикс
 *    едут одни имена, и сервер стоит 349 токенов; без него уезжают схемы, и тот
 *    же сервер стоит 6007 — в 17 раз больше (1.7). В жадном режиме схем в
 *    транскрипте нет вовсе: они неотделимы от системного промпта, и цену такого
 *    сервера мы **не знаем**. Такие сессии считаются отдельно и называются
 *    вслух, а не подмешиваются к измеренному.
 * 2. **Ноль вызовов — это ноль за период, а не «никогда».** Сервер могли не
 *    позвать сегодня и звать каждый вторник. Поэтому рядом с советом стоит,
 *    в скольких сессиях сервер грузился, а период задаёт спрашивающий.
 * 3. **Цифра берётся с экрана, а не считается заново.** Экономия — это ровно
 *    та строка развёртки, которую человек видит рядом; посчитай её здесь вторым
 *    способом, и однажды совет пообещает не то, что показано выше.
 */
import type { Db, SqlValue } from '../index/db.ts'
import { loadedCategories } from './loaded.ts'
import { requestFilter } from './today.ts'
import type { DayRange, RequestScope } from './types.ts'

export interface Saving {
  /** Имя сервера MCP как его назвал провайдер в имени тула. */
  source: string
  /** Сколько токенов постоянного расхода ушло на него за период. */
  tokens: number
  /** Во сколько он обходится в одной сессии. */
  perSession: number
  /** Сколько его инструментов уехало в префикс. */
  loaded: number
  /** В скольких сессиях периода он грузился. */
  sessions: number
  /**
   * Сессии, где набор был жадным: схемы уехали в системный промпт, и цену
   * сервера в них измерить нечем — она **больше** показанной, а насколько,
   * из логов не видно. Ноль — вся цена выше измерена.
   */
  unmeasured: number
  /** Проекты, в которых он грузился. Всегда непусто. */
  projects: string[]
}

export function savings(db: Db, range: DayRange, scope: RequestScope = {}): Saving[] {
  const filter = requestFilter(range, scope)
  const mcp = loadedCategories(db, range, scope).find((row) => row.category === 'mcpTools')
  if (mcp === undefined) return []

  const sessions = sessionsPerServer(db, filter)
  return mcp.sources
    .filter((source) => source.calls === 0 && source.tokens > 0)
    .map((source): Saving => {
      const own = sessions.get(source.source)
      return {
        source: source.source,
        tokens: source.tokens,
        perSession: source.perSession,
        loaded: source.loaded,
        sessions: own?.sessions ?? 0,
        unmeasured: own?.eager ?? 0,
        projects: own?.projects ?? [],
      }
    })
    .sort((left, right) => right.tokens - left.tokens || left.source.localeCompare(right.source))
}

interface ServerSessions {
  sessions: number
  eager: number
  projects: string[]
}

function sessionsPerServer(
  db: Db,
  filter: { sql: string; params: SqlValue[] },
): Map<string, ServerSessions> {
  const rows = db.all<{ source: string; project: string; deferred: number }>(
    `SELECT prefix_blocks.source AS source, sessions.project AS project,
            sessions.tools_deferred AS deferred
     FROM prefix_blocks
     JOIN sessions ON sessions.id = prefix_blocks.session_id
     WHERE prefix_blocks.category = 'mcpTools' AND prefix_blocks.source IS NOT NULL
       AND prefix_blocks.session_id IN (
         SELECT DISTINCT requests.session_id
         FROM requests
         JOIN sessions ON sessions.id = requests.session_id
         WHERE ${filter.sql}
       )`,
    ...filter.params,
  )

  const result = new Map<string, ServerSessions>()
  for (const row of rows) {
    const own = result.get(row.source) ?? { sessions: 0, eager: 0, projects: [] }
    own.sessions += 1
    if (row.deferred === 0) own.eager += 1
    if (!own.projects.includes(row.project)) own.projects.push(row.project)
    result.set(row.source, own)
  }
  for (const own of result.values()) own.projects.sort()
  return result
}
