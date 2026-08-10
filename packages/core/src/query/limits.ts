import type { ClaudeLimits } from '../config/types.ts'
import type { Db } from '../index/db.ts'
import { readLimitWindows } from '../index/limits.ts'
import type { LimitWindow } from '../sources/types.ts'
import { sourceCount } from './today.ts'
import type { LimitReportRow, LimitsReport } from './types.ts'

/**
 * Отчёт только читает. Пересборку окон делает тот, кто менял вход: `ingestAll`
 * после прохода и живой слой при смене конфига (`ensureLimitWindows`).
 *
 * Раньше пересборка стояла прямо здесь, и это был полный проход по всем
 * запросам Claude на каждый опрос трея плюс скрытая запись из читающего
 * модуля — известный долг 1.10.
 */
export function limitsReport(db: Db, at: number, limits: ClaudeLimits): LimitsReport {
  const windows = readLimitWindows(db)
  return {
    emptyIndex: sourceCount(db) === 0,
    at,
    windows: windows
      .filter((window) => window.startsAt <= at && at < window.resetsAt)
      .map((window): LimitReportRow => ({
        ...window,
        unavailableReason: unavailableReason(window, limits),
      })),
  }
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
