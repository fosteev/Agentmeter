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
  type CurrentTurn as CoreCurrentTurn,
  type SourceIssue,
  type Db,
  type LiveAgent as CoreLiveAgent,
  type LiveLayer,
  type Totals,
  type UsageSnapshot,
  t,
} from '@agentmeter/core'
import type { Privacy } from './day.ts'
import { measured } from './measured.ts'
import type {
  ContextUsage,
  CurrentTurn,
  DayTotals,
  LastAgent,
  LiveAgent,
  Measured,
  SourceProblem,
  TraySnapshot,
} from '@agentmeter/ipc'

export interface SnapshotInput {
  /** Источники, до которых не добрались на последнем обходе. */
  issues?: readonly SourceIssue[]
  at?: number
  /**
   * Ответ Anthropic про лимиты и состояние источника (6.3).
   *
   * Приезжает сюда, а не читается отсюда: снимок собирается на каждый опрос
   * трея, а ходить в сеть решает `pollOauth` — раз в четверть часа и только
   * при включённой настройке.
   */
  oauth?: { enabled: boolean; snapshot?: UsageSnapshot; retryAt?: number }
}

export function buildSnapshot(
  db: Db,
  live: LiveLayer,
  config: Config,
  input: SnapshotInput = {},
): TraySnapshot {
  const at = input.at ?? Date.now()
  const liveSnapshot = live.snapshot(at)
  // Ответ провайдера сильнее нашего расчёта — и по проценту, и по границам
  // окна: лимит считается по аккаунту, и окно могло начаться с запроса,
  // которого у нас нет. Подробности — в шапке `replaceClaude`.
  const limits = limitsReport(
    db,
    at,
    config.limits.claude,
    undefined,
    input.oauth?.snapshot,
  ).windows
  const today = todayReport(db, dayRange(at, config.ui.dayStartsAtHour))

  const snapshot: TraySnapshot = {
    at,
    agents: liveSnapshot.agents.map((agent) => toAgent(agent, config.privacy)),
    limits,
    today: toDayTotals(today.totals, today.approximate, today.sessions, today.projects.length),
    // Пустой список — это утверждение «источники прочитаны», а не молчание.
    problems: toProblems(input.issues ?? []),
    // Откуда взялись проценты Claude и можно ли спросить заново (6.3). Поле
    // есть всегда: «источник выключен» — такое же утверждение, как «спрошено
    // две минуты назад», и попапу нужно различать их, а не догадываться по
    // отсутствию.
    limitsSource: {
      enabled: input.oauth?.enabled ?? false,
      ...(input.oauth?.snapshot === undefined ? {} : { askedAt: input.oauth.snapshot.ts }),
      ...(input.oauth?.retryAt === undefined ? {} : { retryAt: input.oauth.retryAt }),
    },
  }

  // Кого видели последним — только когда сейчас никого нет: попапу это нужно
  // ровно для одного экрана, а лишний запрос на каждый опрос трея не нужен
  // никому.
  if (snapshot.agents.length === 0) {
    const last = lastAgent(db)
    if (last !== undefined) snapshot.lastAgent = last
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

/** Имена продуктов не переводятся: это их названия, а не слова. */
const PROVIDER_NAME: Record<SourceIssue['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
}

/**
 * Недоступные источники → то, что покажет попап (2.8).
 *
 * Схлопывается до одной строки на провайдера: `EACCES` на корневом каталоге
 * даёт по проблеме на каждый вложенный, и вываливать их в попап списком значит
 * прятать единственную важную мысль — «цифры этого провайдера неполные» — за
 * сотней одинаковых строк.
 *
 * Последствие пишется здесь, а не в окне: оно зависит от того, кто ещё
 * прочитался. Окно этого не знает, а сочинённое им «наверное, что-то неполное»
 * однажды успокоит там, где успокаивать нельзя.
 */
export function toProblems(issues: readonly SourceIssue[]): SourceProblem[] {
  const byProvider = new Map<SourceIssue['provider'], SourceIssue>()
  for (const issue of issues) {
    if (!byProvider.has(issue.provider)) byProvider.set(issue.provider, issue)
  }
  const broken = [...byProvider.keys()]
  return broken.map((provider) => {
    const issue = byProvider.get(provider)!
    const others = (['claude', 'codex'] as const).filter((name) => !broken.includes(name))
    const intact =
      others.length === 0
        ? ''
        : t('note.sourceIntact', {
            names: others.map((name) => PROVIDER_NAME[name]).join(t('popup.and')),
          })
    return {
      provider,
      path: issue.path,
      code: issue.code,
      consequence: t('note.sourceBroken', { intact, provider: PROVIDER_NAME[provider] }),
    }
  })
}

/**
 * Последняя закончившаяся сессия — для экрана «никого нет» (2.8).
 *
 * Сабагенты исключены: своего процесса у них нет, и «последним работал
 * general-purpose» — это не то, что человек видел на экране. Ищется по концу
 * сессии, а не по началу: последней начатой могла быть та, что оборвалась
 * первой.
 */
function lastAgent(db: Db): LastAgent | undefined {
  const row = db.get<{ provider: string; project: string; ended_at: number }>(
    `SELECT provider, project, ended_at
     FROM sessions
     WHERE parent_session_id IS NULL AND is_sidechain = 0
     ORDER BY ended_at DESC
     LIMIT 1`,
  )
  if (row === undefined) return undefined
  return {
    provider: row.provider as LastAgent['provider'],
    project: row.project,
    endedAt: row.ended_at,
  }
}

function toAgent(agent: CoreLiveAgent, privacy: Privacy): LiveAgent {
  const result: LiveAgent = {
    sessionId: agent.sessionId,
    provider: agent.provider,
    project: agent.project,
    cwd: agent.cwd,
    entrypoint: agent.entrypoint,
    startedAt: agent.startedAt,
    state: agent.state,
    tokens: agent.tokens,
    requests: agent.requests,
    approximate: agent.approximate,
    rate: agent.rate,
  }
  if (agent.branch !== undefined) result.branch = agent.branch
  if (agent.model !== undefined) result.model = agent.model
  if (agent.endedAt !== undefined) result.endedAt = agent.endedAt
  if (agent.pendingTool !== undefined) result.pendingTool = agent.pendingTool
  if (agent.context !== undefined) result.context = toContext(agent.context)
  const turn = toCurrentTurn(agent.currentTurn, privacy)
  if (turn !== undefined) result.currentTurn = turn
  return result
}

/**
 * Текущий ход наружу (6.1).
 *
 * «Скрыть тексты промптов» (3.6) снимает **текст**, а не ход целиком: расход с
 * начала хода — это цифра о расходе, а не о содержании работы, и прятать её
 * вместе с вопросом значило бы наказывать за приватность потерей измерения.
 * Тем же правилом живёт первый промпт в ленте: поля просто нет, пустой строки
 * вместо него не бывает.
 */
export function toCurrentTurn(
  turn: CoreCurrentTurn | undefined,
  privacy: Privacy,
): CurrentTurn | undefined {
  if (turn === undefined) return undefined
  const out: CurrentTurn = {}
  if (turn.prompt !== undefined && privacy.hidePrompts !== true) out.prompt = turn.prompt
  if (turn.startedAt !== undefined) out.startedAt = turn.startedAt
  if (turn.spend !== undefined) {
    out.spend = {
      tokens: measured(turn.spend.tokens, turn.spend.reconstructed > 0),
      requests: turn.spend.requests,
    }
  }
  return out.prompt === undefined && out.startedAt === undefined ? undefined : out
}

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
  if (context.source !== 'log') used.caveat = t('caveat.observedWindow')
  return used
}

/**
 * Точность приписывается не всем полям подряд: восстановленное — это всегда
 * `cache_read`, а сумма наследует худшую из четырёх, потому что содержит его
 * внутри себя. Сам перевод живёт в `measured.ts` — фраза оговорки видна
 * пользователю, и копий у неё быть не должно.
 */
function toDayTotals(
  totals: Totals | null,
  approximate: boolean,
  sessions: number | null,
  projects: number,
): DayTotals {
  const exact = (value: number): Measured => ({ value, confidence: 'exact' })
  return {
    input: exact(totals?.input ?? 0),
    output: exact(totals?.output ?? 0),
    cacheWrite: exact(totals?.cacheWrite ?? 0),
    cacheRead: measured(totals?.cacheRead ?? 0, approximate),
    total: measured(totals?.total ?? 0, approximate),
    requests: totals?.requests ?? 0,
    sessions: sessions ?? 0,
    projects,
  }
}
