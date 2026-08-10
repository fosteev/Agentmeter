import type { ClaudeLimits } from '../config/types.ts'
import type { Db, SqlValue } from '../index/db.ts'
import { readLimitWindows } from '../index/limits.ts'
import { DEFAULT_RATE_WINDOW_MS, perMinute } from '../live/rate.ts'
import type { LimitWindow } from '../sources/types.ts'
import { sourceCount } from './today.ts'
import type { LimitForecast, LimitReportRow, LimitsReport } from './types.ts'

/**
 * Отчёт только читает. Пересборку окон делает тот, кто менял вход: `ingestAll`
 * после прохода и живой слой при смене конфига (`ensureLimitWindows`).
 *
 * Раньше пересборка стояла прямо здесь, и это был полный проход по всем
 * запросам Claude на каждый опрос трея плюс скрытая запись из читающего
 * модуля — известный долг 1.10.
 */
export function limitsReport(
  db: Db,
  at: number,
  limits: ClaudeLimits,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
): LimitsReport {
  const windows = readLimitWindows(db)
  return {
    emptyIndex: sourceCount(db) === 0,
    at,
    windows: windows
      .filter((window) => window.startsAt <= at && at < window.resetsAt)
      .map((window): LimitReportRow => ({
        ...window,
        unavailableReason: unavailableReason(window, limits),
        forecast: forecastFor(db, window, at, rateWindowMs),
      })),
  }
}

/**
 * Когда упрёмся в потолок — этап 2.3.
 *
 * Потолка в токенах у нас нет ни у одного провайдера: Codex сообщает только
 * процент, у Claude потолок задаётся руками и до 1.9 бесполезен. Зато процент
 * можно привязать к нашему собственному замеру: если за окно мы насчитали
 * `W` токенов и провайдер говорит «израсходовано `p`%», то цена процента —
 * `W / p` токенов, и остаток до потолка выражается в тех же токенах. Единица
 * при делении сокращается, поэтому взвешивать `cache_read` здесь не нужно —
 * и прогноз работает у Codex уже сейчас, до калибровки 1.9.
 *
 * Допущение ровно одно и оно названо: доля видов токенов в хвостовом окне та
 * же, что за всё окно лимита. Поэтому это оценка, а не измерение.
 */
function forecastFor(
  db: Db,
  window: LimitWindow,
  at: number,
  rateWindowMs: number,
): LimitForecast | null {
  // Ноль процентов не даёт цены процента: делить на него нечем, и это не то же
  // самое, что «темп нулевой».
  if (window.usedPercent === null || window.usedPercent <= 0) return null

  const windowSpent = spent(db, window.provider, window.startsAt, Math.min(at, window.resetsAt))
  if (windowSpent <= 0) return null

  // Хвостовое окно не должно вылезать за начало окна лимита: чужие токены в
  // числителе завысили бы темп ровно в момент, когда окно только открылось.
  const from = Math.max(at - rateWindowMs, window.startsAt)
  const tokensPerMinute = perMinute(spent(db, window.provider, from, at), at - from)
  if (tokensPerMinute === 0) return { tokensPerMinute: 0, minutesToCap: null, resetsFirst: false }

  const tokensToCap = (windowSpent / window.usedPercent) * (100 - window.usedPercent)
  const minutesToCap = Math.max(0, Math.round(tokensToCap / tokensPerMinute))
  return {
    tokensPerMinute,
    minutesToCap,
    resetsFirst: minutesToCap * 60_000 > window.resetsAt - at,
  }
}

function spent(db: Db, provider: string, from: number, to: number): number {
  if (to <= from) return 0
  const row = db.get<{ tokens: number | null }>(
    `SELECT sum(requests.input + requests.output + requests.cache_write + requests.cache_read) AS tokens
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE sessions.provider = ? AND requests.ts >= ? AND requests.ts < ?`,
    provider as SqlValue,
    from as SqlValue,
    to as SqlValue,
  )
  return row?.tokens ?? 0
}

function unavailableReason(window: LimitWindow, limits: ClaudeLimits): string | null {
  if (window.usedPercent !== null) return null
  if (window.provider !== 'claude') return 'провайдер не сообщил процент'
  if (limits.cacheReadWeight === null) return 'вес cache_read не откалиброван, этап 1.9'
  if (window.kind === 'fiveHour' && limits.fiveHourCap === null)
    return 'потолок пятичасового плана не задан'
  if (window.kind === 'weekly' && limits.weeklyCap === null)
    return 'потолок недельного плана не задан'
  return 'потолок плана не задан'
}
