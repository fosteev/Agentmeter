/**
 * Скорость модели (8.4) — «сколько ждали ответ» и темп, каким его видит человек.
 *
 * Обе величины берутся из `requests.duration_ms`, который парсер меряет от
 * записи, отдавшей модели промпт, до последней записанной части ответа
 * (границы по провайдерам — в [`8.4-speed.md`](../../../../docs/roadmap/8.4-speed.md)).
 * Это **не** скорость генерации: первая строка ответа Claude пишется по
 * завершении блока, и время до первого токена от генерации отделить нечем.
 *
 * Агрегат — медианы, а не `Σ output / Σ duration`. На живой машине у
 * `claude-fable-5-1` первая даёт 65.5 тк/с, вторая 44.6: хвост долгих ожиданий
 * (повторы после 529, перегрузка) съедает треть, и «типичным» становится
 * число, которого не было ни на одном запросе. Поэтому темп считается на
 * **каждом** запросе, и медиана берётся уже от темпов.
 *
 * Процентилей в `node:sqlite` без расширений нет, поэтому выборка тянется
 * одним запросом и считается в памяти. Тянется не строками, а по строке на
 * модель: пары «время, output» склеены `group_concat` в один JSON-массив.
 * Замер на неделе живой машины (9 400 запросов): построчно — 9.7 мс, и
 * `spendMatrix` вылезал из кадра (16.6 мс против 7.0 до этапа); одной строкой
 * на модель — 5.1 мс. Оконные функции SQLite (`row_number() OVER`) дали 20 мс.
 */
import type { Db } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { requestFilter } from './today.ts'
import type { DayRange, RequestScope } from './types.ts'

export const SPEED = {
  /**
   * Меньше скольких измеренных запросов скорости у модели нет вовсе. Медиана
   * из двух — это не «типичное», а два случая; экран пишет «мало данных».
   */
  minRequests: 5,
} as const

/** Скорость одной модели за период: только измеренные запросы. */
export interface ModelSpeed {
  /** Сколько запросов с измеренным временем легло в выборку. */
  requests: number
  /** Медиана времени ответа, мс. */
  p50Ms: number
  /** 90-й процентиль времени ответа, мс: хвост из повторов и перегрузки. */
  p90Ms: number
  /** Медиана `output / duration` по запросам, токенов в секунду, до 0.1. */
  tokensPerSecond: number
}

interface SampleRow {
  provider: Provider
  model: string
  n: number
  /** JSON-массив `[время₀, output₀, время₁, output₁, …]` — одним агрегатом, чтобы пары не разъехались. */
  pairs: string
}

/**
 * Скорость по моделям за период и сужение. Ключ — `провайдер модель`, тот же,
 * что у маргинали матрицы: имя модели само по себе провайдера не называет.
 *
 * Модели ниже `SPEED.minRequests` в ответе **нет** — ни нулём, ни медианой из
 * того, что было.
 */
export function modelSpeeds(
  db: Db,
  range: DayRange,
  scope: RequestScope = {},
): Map<string, ModelSpeed> {
  const filter = requestFilter(range, scope)
  // `duration_ms IS NOT NULL`, а не `coalesce(…, 0)`: у восстановленного
  // запроса и у запроса с перепутанным порядком записей времени нет, и ноль в
  // выборке сдвинул бы медиану к «мгновенно» — числом, которого не было.
  const rows = db.all<SampleRow>(
    `SELECT sessions.provider AS provider, requests.model AS model, count(*) AS n,
            '[' || group_concat(requests.duration_ms || ',' || requests.output) || ']' AS pairs
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql} AND requests.duration_ms IS NOT NULL
     GROUP BY sessions.provider, requests.model`,
    ...filter.params,
  )

  const out = new Map<string, ModelSpeed>()
  for (const row of rows) {
    if (row.n < SPEED.minRequests) continue
    const pairs = JSON.parse(row.pairs) as number[]
    const durations = new Float64Array(row.n)
    const paces = new Float64Array(row.n)
    for (let index = 0; index < row.n; index += 1) {
      const duration = pairs[index * 2]!
      durations[index] = duration
      paces[index] = (pairs[index * 2 + 1]! * 1000) / duration
    }
    // Типизированный массив сортируется численно и без компаратора.
    durations.sort()
    paces.sort()
    out.set(speedKey(row.provider, row.model), {
      requests: row.n,
      p50Ms: Math.round(quantile(durations, 0.5)),
      p90Ms: Math.round(quantile(durations, 0.9)),
      tokensPerSecond: Math.round(quantile(paces, 0.5) * 10) / 10,
    })
  }
  return out
}

/** Ключ модели — пара «провайдер + модель», как у маргинали матрицы. */
export function speedKey(provider: Provider, model: string): string {
  return `${provider} ${model}`
}

/**
 * Квантиль с линейной интерполяцией между соседями (то, что `numpy` зовёт
 * `linear`): медиана чётной выборки — середина между двумя средними.
 */
function quantile(sorted: Float64Array, q: number): number {
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)
}
