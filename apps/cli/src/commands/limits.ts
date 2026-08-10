import type { LimitForecast, LimitsReport } from '@agentmeter/core'
import { t } from '@agentmeter/core'
import { formatDuration, formatTokens, table } from '../format.ts'

export function renderLimits(report: LimitsReport, locale: string): string {
  if (report.emptyIndex) return t('cli.emptyIndex')
  if (report.windows.length === 0) return t('cli.noWindows')
  return table(
    [
      { header: t('cli.columnProvider'), width: 10 },
      { header: t('cli.columnWindow'), width: 12 },
      { header: t('cli.columnSpend'), width: 28 },
      { header: t('cli.columnUntilReset'), width: 12 },
      { header: t('cli.columnRate'), width: 12, align: 'right' },
      { header: t('cli.columnUntilCap'), width: 16 },
      { header: t('cli.columnBasis'), width: 8 },
    ],
    report.windows.map((window) => [
      window.provider,
      kindName(window.kind, window.windowMinutes),
      window.usedPercent === null
        ? `— (${window.unavailableReason ?? t('cli.unknownReason')})`
        : `${window.exact ? '' : '≈'}${window.usedPercent}%`,
      formatDuration(window.resetsAt - report.at, locale),
      window.forecast === null
        ? '—'
        : t('time.perMinute', { tokens: formatTokens(window.forecast.tokensPerMinute, locale) }),
      forecastName(window.forecast, locale),
      window.exact ? t('cli.basisExact') : t('cli.basisEstimate'),
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
  if (forecast.minutesToCap === null) return t('cli.noRate')
  if (forecast.resetsFirst) return t('cli.resetsFirst')
  return `≈${formatDuration(forecast.minutesToCap * 60_000, locale)}`
}

function kindName(kind: string, minutes: number): string {
  if (kind === 'fiveHour') return t('cli.windowFiveHour')
  if (kind === 'weekly') return t('cli.windowWeekly')
  if (kind === 'monthly') return t('cli.windowMonthly')
  return t('time.minutes', { count: minutes })
}
