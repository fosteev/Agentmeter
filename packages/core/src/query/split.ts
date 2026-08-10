/**
 * Постоянное против разового за период — блок «Куда ушло сегодня» (строки
 * 767–777 макета) и левая колонка развёртки (раздел 5).
 *
 * Модель целиком — [`docs/roadmap/4.1-split.md`](../../../../docs/roadmap/4.1-split.md).
 * Здесь три вещи, которые надо помнить, читая код:
 *
 * 1. **Знаменатель — `Σ (ctx + output)`, и это тот же итог, что в шапке.**
 *    `contextTokens` собран из `input + cacheWrite + cacheRead` у обоих
 *    провайдеров, то есть `Totals.total` — та же сумма, записанная иначе.
 *    Проверено на 28 824 запросах, расхождений ноль.
 * 2. **Постоянное — `Σ min(P, ctx)`, а не `P × число запросов`.** Компакт
 *    роняет контекст ниже префикса, и без ограничения сверху разовое ушло бы в
 *    минус. Таких запросов 1 из 28 824 — и на этом единственном держится
 *    свойство «разовое ≥ 0».
 * 3. **Разовое — остаток.** Не самостоятельный счёт: измерены итог и
 *    постоянное, остальное получается вычитанием и потому не может разойтись с
 *    числом над ним.
 */
import type { Db, SqlValue } from '../index/db.ts'
import type { PrefixCategory } from '../sources/types.ts'
import { requestFilter } from './today.ts'
import type { DayRange, RequestScope } from './types.ts'

/** Категория постоянного расхода за период. */
export interface SpendCategory {
  category: PrefixCategory
  /** Имя MCP-сервера; `null` — категория целиком, источника у неё нет. */
  source: string | null
  /**
   * `residual` — измеренный остаток (системный промпт и схемы вшитых тулов),
   * `estimated` — посчитанный по байтам блок. Разница не косметическая: остаток
   * нельзя посоветовать выключить, он и есть сам агент.
   */
  basis: 'estimated' | 'residual'
  /** Токенов за период: цена блока, умноженная на число запросов сессии. */
  tokens: number
  /** Цена блока в одной сессии, суммарно по сессиям периода. Знаменатель для 4.3. */
  perSession: number
  /** Сколько сессий периода несли эту статью — делитель «цены за сессию». */
  sessions: number
  /**
   * Сколько штук загружено, в среднем на сессию: скиллов в листинге, тулов у
   * сервера. Складывать по сессиям нельзя — один и тот же сервер загружался в
   * каждой, и сумма сказала бы «двести серверов» там, где их четыре.
   */
  items: number
}

export interface SpendSplitReport {
  /** `Σ (ctx + output)` за период — тот же итог, что у `todayReport`. */
  total: number
  /** `Σ min(P, ctx)` — стартовый префикс, перечитанный каждым запросом. */
  recurring: number
  /** Остаток: работа и её перечитывание. */
  marginal: number
  /**
   * Сколько из постоянного стоила **первая** запись префикса — по `P` на
   * сессию, и только на сессии, начавшиеся внутри периода. Всё остальное
   * постоянное — перечитывание; на живых логах его 98.2%.
   */
  firstRead: number
  /** Сколько сессий начиналось внутри периода — множитель первой записи. */
  sessions: number
  /** Категории по убыванию расхода. Сумма `tokens` равна `recurring` до токена. */
  categories: SpendCategory[]
}

interface SessionRow {
  session_id: string
  prefix_tokens: number
  recurring: number
  started: number
}

interface BlockRow {
  session_id: string
  category: PrefixCategory
  source: string | null
  basis: 'estimated' | 'residual'
  tokens: number
  items: number
}

export function spendSplit(db: Db, range: DayRange, scope: RequestScope = {}): SpendSplitReport {
  const filter = requestFilter(range, scope)
  const totals = db.get<{ total: number; recurring: number }>(
    `SELECT coalesce(sum(requests.context_tokens + requests.output), 0) AS total,
            coalesce(sum(min(sessions.prefix_tokens, requests.context_tokens)), 0) AS recurring
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}`,
    ...filter.params,
  )!

  const sessions = sessionRows(db, filter)
  const started = sessions.filter((row) => row.started >= range.from && row.started < range.to)

  return {
    total: totals.total,
    recurring: totals.recurring,
    marginal: totals.total - totals.recurring,
    firstRead: started.reduce((sum, row) => sum + Math.min(row.prefix_tokens, row.recurring), 0),
    sessions: started.length,
    categories: spreadCategories(sessions, blockRows(db, filter)),
  }
}

/**
 * Сколько постоянного пришлось на каждую сессию периода.
 *
 * `started_at` берётся у сессии, а не как минимум `requests.ts` внутри периода:
 * задача, начатая вчера, не платит сегодня за первую запись префикса, она
 * заплатила вчера. Считай мы началом первый запрос дня — переползающие через
 * полночь сессии платили бы за запись дважды (таких 32 из 617).
 */
function sessionRows(db: Db, filter: { sql: string; params: SqlValue[] }): SessionRow[] {
  return db.all<SessionRow>(
    `SELECT requests.session_id,
            sessions.prefix_tokens,
            sessions.started_at AS started,
            sum(min(sessions.prefix_tokens, requests.context_tokens)) AS recurring
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}
     GROUP BY requests.session_id`,
    ...filter.params,
  )
}

function blockRows(db: Db, filter: { sql: string; params: SqlValue[] }): BlockRow[] {
  return db.all<BlockRow>(
    `SELECT prefix_blocks.session_id, prefix_blocks.category, prefix_blocks.source,
            prefix_blocks.basis, prefix_blocks.tokens, prefix_blocks.items
     FROM prefix_blocks
     WHERE prefix_blocks.session_id IN (
       SELECT DISTINCT requests.session_id
       FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE ${filter.sql}
     )
     ORDER BY prefix_blocks.session_id, prefix_blocks.idx`,
    ...filter.params,
  )
}

/**
 * Постоянное сессии, разложенное по её же блокам.
 *
 * Дележ — по наибольшей дробной части, тем же правилом, что `splitResidual`
 * (1.6) и `attributePrefix` (1.7): сумма долей равна целому **до токена** на
 * любом входе, а не с точностью до округления. Умножь мы вместо этого каждый
 * блок на `recurring / P` по отдельности — сумма разошлась бы с постоянным на
 * единицы токенов, и разошлась бы молча.
 */
function spreadCategories(sessions: SessionRow[], blocks: BlockRow[]): SpendCategory[] {
  const bySession = new Map<string, BlockRow[]>()
  for (const block of blocks) {
    bySession.set(block.session_id, [...(bySession.get(block.session_id) ?? []), block])
  }

  const totals = new Map<string, SpendCategory>()
  for (const session of sessions) {
    const own = bySession.get(session.session_id) ?? []
    if (own.length === 0) continue
    const shares = splitByLargestRemainder(
      own.map((block) => block.tokens),
      session.recurring,
    )
    own.forEach((block, index) => {
      const key = `${block.category}\u0000${block.source ?? ''}\u0000${block.basis}`
      const current = totals.get(key) ?? {
        category: block.category,
        source: block.source,
        basis: block.basis,
        tokens: 0,
        perSession: 0,
        sessions: 0,
        items: 0,
      }
      current.tokens += shares[index] ?? 0
      current.perSession += block.tokens
      current.sessions += 1
      current.items += block.items
      totals.set(key, current)
    })
  }

  return [...totals.values()]
    .map((row) => ({ ...row, items: Math.round(row.items / Math.max(1, row.sessions)) }))
    .sort(
      (left, right) =>
        right.tokens - left.tokens ||
        left.category.localeCompare(right.category) ||
        (left.source ?? '').localeCompare(right.source ?? ''),
    )
}

/**
 * Дележ целого по весам, детерминированный до токена.
 *
 * Отрицательный вес возможен: остаток `system` уходит в минус, если видимые
 * блоки переоценены (на живых логах такого нет, но переоценить их может новая
 * версия CLI). Тогда делить пропорционально нечем — весов с разными знаками
 * нормировать нельзя, — и всё уходит первому блоку целиком. Молчать про такой
 * случай нельзя, поэтому он назван здесь, а проверка на него стоит в
 * `prefix-live.ts`.
 */
function splitByLargestRemainder(weights: number[], total: number): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  if (totalWeight <= 0 || weights.some((weight) => weight < 0)) {
    return weights.map((_, index) => (index === 0 ? total : 0))
  }
  const shares = weights.map((weight, index) => {
    const exact = (total * weight) / totalWeight
    const tokens = Math.floor(exact)
    return { index, tokens, fraction: exact - tokens }
  })
  const remaining = total - shares.reduce((sum, share) => sum + share.tokens, 0)
  const byRemainder = [...shares].sort(
    (left, right) => right.fraction - left.fraction || left.index - right.index,
  )
  for (let index = 0; index < remaining; index += 1) {
    const share = byRemainder[index]
    if (share) share.tokens += 1
  }
  return shares.map((share) => share.tokens)
}
