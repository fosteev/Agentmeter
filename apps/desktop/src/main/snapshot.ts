/**
 * Живой слой (2.1) и агрегаты (1.10) → `TraySnapshot` контракта 0.4.
 *
 * Здесь и только здесь считаются числа, которые увидит окно. Правило контракта
 * «рендерер не считает» держится не уговором, а тем, что наружу уезжает готовое
 * к показу: сумма за сутки посчитана вместе со своей точностью, окна лимита
 * приезжают с причиной недоступности и прогнозом. Стоит сложить что-нибудь в
 * компоненте — и та же цифра окажется посчитанной дважды, а разойдутся они
 * молча.
 */
import {
  dayRange,
  limitsReport,
  todayReport,
  type Config,
  type ContextFill as CoreContextFill,
  type Db,
  type LiveAgent as CoreLiveAgent,
  type LiveLayer,
  type Totals,
} from '@agentmeter/core'
import type { ContextUsage, DayTotals, LiveAgent, Measured, TraySnapshot } from '@agentmeter/ipc'

export function buildSnapshot(
  db: Db,
  live: LiveLayer,
  config: Config,
  at: number = Date.now(),
): TraySnapshot {
  const liveSnapshot = live.snapshot(at)
  const limits = limitsReport(db, at, config.limits.claude).windows
  const today = todayReport(db, dayRange(at, config.ui.dayStartsAtHour))

  const snapshot: TraySnapshot = {
    at,
    agents: liveSnapshot.agents.map(toAgent),
    limits,
    today: toDayTotals(today.totals, today.approximate, today.sessions, today.projects.length),
  }

  // Ближайший к потолку — только среди окон с известным процентом. У Claude до
  // калибровки веса `cache_read` (1.9) процента нет вовсе, и подставлять сюда
  // ноль значило бы красить иконку трея в спокойный цвет на незнании.
  const known = limits
    .map((window) => window.usedPercent)
    .filter((percent): percent is number => percent !== null)
  if (known.length > 0) snapshot.nearestLimitPercent = Math.max(...known)

  return snapshot
}

function toAgent(agent: CoreLiveAgent): LiveAgent {
  const result: LiveAgent = {
    sessionId: agent.sessionId,
    provider: agent.provider,
    project: agent.project,
    cwd: agent.cwd,
    entrypoint: agent.entrypoint,
    startedAt: agent.startedAt,
    state: agent.state,
    tokens: agent.tokens,
    approximate: agent.approximate,
    rate: agent.rate,
  }
  if (agent.branch !== undefined) result.branch = agent.branch
  if (agent.model !== undefined) result.model = agent.model
  if (agent.endedAt !== undefined) result.endedAt = agent.endedAt
  if (agent.context !== undefined) result.context = toContext(agent.context)
  return result
}

const OBSERVED_WINDOW =
  'размер окна Claude в логи не пишется — выведен из наблюдавшегося максимума, этап 2.6'

/**
 * Происхождение размера окна переводится в точность здесь, а не в компоненте.
 *
 * У Codex знаменатель написал провайдер (`model_context_window`), у Claude его
 * нет вовсе, и мы берём наименьшее стандартное окно, вмещающее наблюдавшийся
 * максимум. Первое — измерение, второе — оценка, и различить их обязано то
 * место, которое знает, откуда число, а не то, которое его рисует.
 */
export function toContext(context: CoreContextFill): ContextUsage {
  const used: ContextUsage = {
    used: context.used,
    window: context.window,
    fill: context.fill,
    confidence: context.source === 'log' ? 'exact' : 'estimate',
  }
  if (context.source !== 'log') used.caveat = OBSERVED_WINDOW
  return used
}

const RECONSTRUCTED = 'часть запросов восстановлена по разрыву цепочки кэша, этап 1.3'

/**
 * Точность приписывается не всем полям подряд.
 *
 * Незаписанные запросы (1.3) восстанавливаются по разрыву цепочки кэша, и
 * восстановленное — это всегда `cache_read`. Значит помечать оценкой `input` и
 * `output` нечестно в другую сторону: они прочитаны как есть. А сумма наследует
 * худшую из четырёх, потому что содержит восстановленное внутри себя.
 */
function toDayTotals(
  totals: Totals | null,
  approximate: boolean,
  sessions: number | null,
  projects: number,
): DayTotals {
  const exact = (value: number): Measured => ({ value, confidence: 'exact' })
  const cacheRead: Measured = approximate
    ? { value: totals?.cacheRead ?? 0, confidence: 'reconstructed', caveat: RECONSTRUCTED }
    : exact(totals?.cacheRead ?? 0)
  const total: Measured = approximate
    ? { value: totals?.total ?? 0, confidence: 'reconstructed', caveat: RECONSTRUCTED }
    : exact(totals?.total ?? 0)

  return {
    input: exact(totals?.input ?? 0),
    output: exact(totals?.output ?? 0),
    cacheWrite: exact(totals?.cacheWrite ?? 0),
    cacheRead,
    total,
    requests: totals?.requests ?? 0,
    sessions: sessions ?? 0,
    projects,
  }
}
