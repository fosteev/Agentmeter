import type { LimitForecast, LimitsReport } from '@agentmeter/core'
import { formatDuration, formatTokens, table } from '../format.ts'

export function renderLimits(report: LimitsReport, locale: string): string {
  if (report.emptyIndex) return 'индекс пуст, запустите `agentmeter index`'
  if (report.windows.length === 0) return 'текущих окон лимита нет'
  return table(
    [
      { header: 'Провайдер', width: 10 },
      { header: 'Окно', width: 12 },
      { header: 'Расход', width: 28 },
      { header: 'До сброса', width: 12 },
      { header: 'Темп', width: 12, align: 'right' },
      { header: 'До упора', width: 16 },
      { header: 'Основа', width: 8 },
    ],
    report.windows.map((window) => [
      window.provider,
      kindName(window.kind, window.windowMinutes),
      window.usedPercent === null
        ? `— (${window.unavailableReason ?? 'неизвестно'})`
        : `${window.exact ? '' : '≈'}${window.usedPercent}%`,
      formatDuration(window.resetsAt - report.at, locale),
      window.forecast === null ? '—' : `${formatTokens(window.forecast.tokensPerMinute, locale)}/мин`,
      forecastName(window.forecast, locale),
      window.exact ? 'точно' : 'оценка',
    ]),
  )
}

/**
 * Прогноз всегда со знаком «≈»: он продлевает в будущее темп последних минут, а
 * не измеряет что-либо. «Сбросится раньше» — не «всё хорошо», а другое
 * утверждение: до упора при этом темпе не дойдёт.
 */
function forecastName(forecast: LimitForecast | null, locale: string): string {
  if (forecast === null) return '—'
  if (forecast.minutesToCap === null) return 'темпа нет'
  if (forecast.resetsFirst) return 'сбросится раньше'
  return `≈${formatDuration(forecast.minutesToCap * 60_000, locale)}`
}

function kindName(kind: string, minutes: number): string {
  if (kind === 'fiveHour') return '5 часов'
  if (kind === 'weekly') return 'неделя'
  if (kind === 'monthly') return 'месяц'
  return `${minutes} мин`
}
