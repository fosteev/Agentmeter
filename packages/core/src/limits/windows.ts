import type { LimitObservation, LimitWindow, LimitWindowKind } from '../sources/types.ts'

const MINUTE_MS = 60_000
const MIN_ANCHOR_TOLERANCE_MS = 120_000

/** Наблюдения (из всех роллаутов сразу) → непересекающаяся цепочка окон. */
export function buildCodexWindows(observations: LimitObservation[]): LimitWindow[] {
  const sorted = [...observations].sort((left, right) => left.ts - right.ts)
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

  return [...chains.values()].flat().sort(compareWindows)
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

function kindForMinutes(windowMinutes: number): LimitWindowKind {
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
