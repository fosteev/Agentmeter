import type { LimitObservation, LimitWindow, LimitWindowKind } from '../sources/types.ts'

const MINUTE_MS = 60_000
const MIN_ANCHOR_TOLERANCE_MS = 120_000

/** Наблюдения (из всех роллаутов сразу) → непересекающаяся цепочка окон. */
export function buildCodexWindows(observations: LimitObservation[]): LimitWindow[] {
  // Нулевая длина отсеивается и здесь, а не только в разборе роллаута: индексы,
  // собранные до этой правки, такое наблюдение уже хранят, а переиндексация
  // ради одной строки на 15 407 — цена не по товару. Пропустить её нельзя:
  // запись, назвавшая одну лишь нулевую длину, закрыла бы соседние окна как
  // «провайдер о них больше не говорит» (см. `closeVanished`).
  const sorted = [...observations]
    .filter((observation) => observation.windowMinutes > 0)
    .sort((left, right) => left.ts - right.ts)
  const chains = new Map<number, LimitWindow[]>()

  for (const observation of sorted) {
    const startsAt = observation.resetsAt - observation.windowMinutes * MINUTE_MS
    const tolerance = Math.max(
      MIN_ANCHOR_TOLERANCE_MS,
      observation.windowMinutes * MINUTE_MS * 0.02,
    )
    const chain = chains.get(observation.windowMinutes) ?? []
    // Старый снимок может приехать после открытия нового окна, поэтому окно
    // ищется по якорю во всей цепочке, а не только среди последних.
    const target = findByAnchor(chain, startsAt, tolerance)

    if (!target) {
      // Якорь не совпал ни с одним известным окном — это отдельное окно,
      // других наблюдений о котором у нас нет. Приписать наблюдение к
      // последнему окну значит завысить чужой процент, поэтому окно встаёт
      // на своё место в цепочке, даже если оно в прошлом.
      insertWindow(chain, createCodexWindow(observation, startsAt))
      chains.set(observation.windowMinutes, chain)
      continue
    }

    // Снимки приезжают не по порядку, поэтому последнее значение ненадёжно.
    if (observation.usedPercent > target.usedPercent!) {
      target.usedPercent = observation.usedPercent
      target.observedAt = observation.ts
    }
  }

  return closeVanished([...chains.values()].flat(), sorted).sort(compareWindows)
}

/**
 * Окно, о котором провайдер перестал говорить, закрывается там, где замолчал.
 *
 * Запись `token_count` перечисляет **весь** набор действующих лимитов, а не тот,
 * что изменился: на живой машине из 15 437 записей 14 716 называют оба окна
 * сразу (300 и 10080), 721 — одно, и ни одной, где названное окно пропадало бы
 * и возвращалось. Значит длина, не названная более поздней записью, в тот
 * момент уже не действовала.
 *
 * Без этого правила окно доживает до собственного `resets_at`, даже если лимита
 * давно нет, — и показывает при этом свой последний процент. Замер: 13 июля
 * аккаунт на сутки оказался на бесплатном плане, Codex сообщил месячное окно
 * (43 200 минут) и довёл его до 100%. Плана нет с 9 августа, а окно оставалось
 * «текущим» до 12 августа и рисовало в попапе `Codex · месячное окно 100%` —
 * число настоящее, утверждение ложное.
 *
 * Записи, не назвавшие **ни одного** окна, не закрывают ничего: у них
 * `plan_type: null` и оба слота пусты — это «данных пока нет», а не «лимитов
 * нет». Таких 28, все в августе.
 *
 * Допущение правила названо и проверено: длина, однажды пропавшая, обратно не
 * возвращается — иначе окно закрывалось бы посреди жизни. На 15 407
 * наблюдениях пропадание ровно одно (недельное окно с 11 июля по 9 августа) и
 * совпадает со сменой плана — на бесплатном недельного лимита не было, а
 * вернулось оно **новым** окном, а не продолжением старого.
 */
function closeVanished(
  windows: LimitWindow[],
  observations: readonly LimitObservation[],
): LimitWindow[] {
  // Наблюдения одной записи делят её метку времени — по ней запись и собирается
  // обратно. Разные записи с одинаковой меткой сольются в одну, и это
  // безопасно: объединение названных длин никого не закрывает лишний раз.
  const named = new Map<number, Set<number>>()
  for (const observation of observations) {
    const lengths = named.get(observation.ts) ?? new Set<number>()
    lengths.add(observation.windowMinutes)
    named.set(observation.ts, lengths)
  }
  const moments = [...named.keys()].sort((left, right) => left - right)

  for (const window of windows) {
    for (const ts of moments) {
      if (ts <= window.observedAt) continue
      if (ts >= window.resetsAt) break
      if (named.get(ts)!.has(window.windowMinutes)) continue
      window.resetsAt = ts
      break
    }
  }
  return windows
}

function findByAnchor(
  chain: LimitWindow[],
  startsAt: number,
  tolerance: number,
): LimitWindow | undefined {
  const position = lowerBound(chain, startsAt)
  const right = chain[position]
  if (right && Math.abs(right.startsAt - startsAt) <= tolerance) return right
  const left = chain[position - 1]
  return left && Math.abs(left.startsAt - startsAt) <= tolerance ? left : undefined
}

/** Вставка с сохранением порядка: цепочка держится сортированной по якорю. */
function insertWindow(chain: LimitWindow[], window: LimitWindow): void {
  const position = lowerBound(chain, window.startsAt)
  const previous = chain[position - 1]
  const next = chain[position]

  // Провайдер иногда переносит якорь до прежнего resetsAt — 2 июля живых логов
  // пятичасовое окно уехало на 52 минуты посреди дня. Окна одного вида
  // пересекаться не могут: новый якорь закрывает предыдущее окно, а не
  // расширяет его, иначе currentWindows увидит сразу два окна одного вида.
  if (previous && previous.resetsAt > window.startsAt) previous.resetsAt = window.startsAt
  if (next && window.resetsAt > next.startsAt) window.resetsAt = next.startsAt

  chain.splice(position, 0, window)
}

function lowerBound(chain: LimitWindow[], startsAt: number): number {
  let low = 0
  let high = chain.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (chain[middle]!.startsAt < startsAt) low = middle + 1
    else high = middle
  }
  return low
}

/** Окно каждого вида, открытое в момент `at`. */
export function currentWindows(
  windows: LimitWindow[],
  at: number,
): Partial<Record<LimitWindowKind, LimitWindow>> {
  const current: Partial<Record<LimitWindowKind, LimitWindow>> = {}

  for (const window of windows) {
    // Правая граница открыта: ровно в resetsAt старое окно уже не текущее.
    if (window.startsAt <= at && at < window.resetsAt) current[window.kind] = window
  }

  return current
}

function createCodexWindow(observation: LimitObservation, startsAt: number): LimitWindow {
  return {
    provider: 'codex',
    // Имя слота потеряно намеренно: после CLI 0.145.0 оно сменило смысл.
    kind: kindForMinutes(observation.windowMinutes),
    windowMinutes: observation.windowMinutes,
    startsAt,
    resetsAt: observation.resetsAt,
    usedPercent: observation.usedPercent,
    observedAt: observation.ts,
    exact: true,
  }
}

/**
 * Длина окна → его вид. Экспортируется, потому что потребителей два: окна из
 * логов (здесь) и окна из ответа провайдера (`codex-oauth.ts`, 6.4). Две копии
 * этой таблицы разошлись бы на первом же новом окне, и разошлись бы молча.
 */
export function kindForMinutes(windowMinutes: number): LimitWindowKind {
  if (windowMinutes === 300) return 'fiveHour'
  if (windowMinutes === 10_080) return 'weekly'
  if (windowMinutes === 43_200) return 'monthly'
  return 'other'
}

function compareWindows(left: LimitWindow, right: LimitWindow): number {
  return (
    left.startsAt - right.startsAt ||
    left.windowMinutes - right.windowMinutes ||
    left.resetsAt - right.resetsAt
  )
}
