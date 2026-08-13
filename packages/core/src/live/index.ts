/**
 * Живой слой: снимок происходящего сейчас плюс журнал времени жизни сессий.
 *
 * Два правила, ради которых он существует отдельно от `query/`.
 *
 * Первое: чтение здесь **периодическое**. Трей опрашивает состояние раз в
 * секунду-две, поэтому «пересчитаем на всякий случай при чтении» превращается в
 * постоянную нагрузку. Решение о пересборке окон лимита принимает этот слой, а
 * не читающий отчёт (долг 1.10).
 *
 * Второе: только здесь видно рождение и смерть процесса агента. В логах этого
 * нет — отсюда «измеренная поправка» в 1.3. Значит, наблюдение надо записывать
 * сразу, задним числом оно не восстанавливается.
 */
import type { ClaudeLimits } from '../config/types.ts'
import type { Db } from '../index/db.ts'
import { ensureLimitWindows } from '../index/limits.ts'
import { collectAgents, createLiveCache, type LiveCache, type LiveOptions } from './agents.ts'
import { appendLifetimes, loadLifetimes } from './lifetimes.ts'
import type { LiveAgent, LiveSnapshot, SessionLifetime } from './types.ts'

export type { LiveOptions } from './agents.ts'
export { DEFAULT_LIVE_OPTIONS, LIVE_URGENCY } from './agents.ts'
export type {
  CurrentTurn,
  LiveAgent,
  LiveSnapshot,
  LiveState,
  SessionLifetime,
} from './types.ts'
export { loadLifetimes, appendLifetimes } from './lifetimes.ts'
export {
  CLAUDE_WINDOWS,
  OBSERVED_WINDOW_DAYS,
  collectContext,
  windowFromObserved,
} from './context.ts'
export type { ContextFill } from './context.ts'
export { bundleOf, ownerApps, processState, processStartTimes, resolveOwners } from './process.ts'
export type { OwnerApp, ProcessRow } from './process.ts'
export { claudeTurn, codexTurn, deriveState, readTurn } from './state.ts'
export type { StateInput, TurnKind, TurnRead } from './state.ts'
export { PROMPT_CHARS, claudePrompt, codexPrompt, readPrompt } from './prompt.ts'
export type { PromptRead } from './prompt.ts'
export {
  DEFAULT_RATE_WINDOW_MS,
  RATE_FLOOR_MS,
  observedSpan,
  perMinute,
  turnTokens,
  windowTokens,
} from './rate.ts'
export type { TurnSpend } from './rate.ts'

export interface LiveLayerOptions extends LiveOptions {
  /** Куда пишется журнал замера. Пустая строка — не писать (тесты, `--json`). */
  lifetimesPath?: string
  /** Как часто сбрасывать в журнал наблюдение за живой сессией. */
  lifetimeFlushMs?: number
  /** Потолки и вес `cache_read` — вход пересборки окон лимита. */
  claudeLimits?: ClaudeLimits
}

export interface LiveLayer {
  snapshot(at?: number): LiveSnapshot
  /** Наблюдения, накопленные в памяти. Порядок — как в журнале. */
  lifetimes(): SessionLifetime[]
  /** Дописать в журнал всё несохранённое. Зовётся при выходе. */
  flush(): void
}

const DEFAULT_FLUSH_MS = 60_000

export function createLiveLayer(db: Db, opts: LiveLayerOptions = {}): LiveLayer {
  const cache: LiveCache = createLiveCache()
  const lifetimesPath = opts.lifetimesPath ?? ''
  const flushMs = opts.lifetimeFlushMs ?? DEFAULT_FLUSH_MS
  const known =
    lifetimesPath === '' ? new Map<string, SessionLifetime>() : loadLifetimes(lifetimesPath)
  const dirty = new Map<string, SessionLifetime>()
  let lastFlushAt = 0

  const write = (records: readonly SessionLifetime[]): void => {
    if (lifetimesPath === '' || records.length === 0) return
    appendLifetimes(lifetimesPath, records)
  }

  return {
    snapshot(at = Date.now()): LiveSnapshot {
      // Окна лимита пересобираются, только если изменился вход сборки. Без
      // этого либо полный проход по запросам на каждый опрос (было), либо
      // замороженные проценты после правки потолка плана в конфиге.
      if (opts.claudeLimits) ensureLimitWindows(db, opts.claudeLimits)

      const snapshot = collectAgents(db, at, opts, cache)
      observe(snapshot, at)
      return snapshot
    },

    lifetimes(): SessionLifetime[] {
      return [...known.values()]
    },

    flush(): void {
      write([...dirty.values()])
      dirty.clear()
    },
  }

  function observe(snapshot: LiveSnapshot, at: number): void {
    const alive = new Set<string>()
    const immediate: SessionLifetime[] = []

    for (const agent of snapshot.agents) {
      // Завершившиеся висят в снимке ещё `doneGraceMs` — ради гашеной строки
      // «завершился 2 мин назад» в макете. Замер 1.3 их живыми считать не
      // должен: иначе `endedAt` в журнале уезжает на всю выдержку, а это
      // единственные данные проекта, которые задним числом не восстановить.
      if (agent.state === 'done') continue
      alive.add(agent.sessionId)
      const previous = known.get(agent.sessionId)
      if (previous === undefined) {
        const record = lifetimeFrom(agent, at, at)
        known.set(agent.sessionId, record)
        immediate.push(record)
        continue
      }
      // firstSeenAt не трогаем никогда: перезапись обнуляет время жизни, и
      // замер хвостовых прогревов молча превращается в ноль.
      previous.lastSeenAt = at
      previous.lastRequestTs = lastRequestTs(agent) ?? previous.lastRequestTs
      if (previous.endedAt !== null) previous.endedAt = null
      dirty.set(agent.sessionId, previous)
    }

    for (const [sessionId, record] of known) {
      if (alive.has(sessionId) || record.endedAt !== null) continue
      // Смерть наблюдена: процесс был в прошлом снимке и его нет сейчас.
      // Это и есть искомое — `endedAt − lastRequestTs`.
      record.endedAt = at
      immediate.push(record)
      dirty.delete(sessionId)
    }

    write(immediate)

    if (at - lastFlushAt >= flushMs && dirty.size > 0) {
      write([...dirty.values()])
      dirty.clear()
      lastFlushAt = at
    }
    if (lastFlushAt === 0) lastFlushAt = at
  }
}

function lifetimeFrom(agent: LiveAgent, firstSeenAt: number, at: number): SessionLifetime {
  const record: SessionLifetime = {
    sessionId: agent.sessionId,
    provider: agent.provider,
    pid: agent.pid,
    startedAt: agent.startedAt,
    firstSeenAt,
    lastSeenAt: at,
    endedAt: null,
    lastRequestTs: lastRequestTs(agent),
  }
  if (agent.cliVersion !== undefined) record.cliVersion = agent.cliVersion
  return record
}

/** Момент последнего записанного запроса. `null` — запросов ещё не было. */
function lastRequestTs(agent: LiveAgent): number | null {
  return agent.lastRequestTs ?? null
}
