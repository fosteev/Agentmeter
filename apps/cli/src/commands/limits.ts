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
      kindName(window),
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

/**
 * Имя окна в колонке шириной 12 знаков.
 *
 * Модельное окно (7.9) названо самой моделью, а не «недельным по модели»: в эту
 * колонку помещается «Fable», а не фраза, и длину окна человек всё равно видит
 * соседней колонкой «до сброса». Своей строкой оно тут пока не появляется —
 * окна по модели приезжают только со вторым источником (6.3), которого у CLI
 * нет, — но безымянная ветка ниже напечатала бы «10080 минут», и разбираться в
 * этом пришлось бы уже по факту.
 */
function kindName(window: LimitsReport['windows'][number]): string {
  if (window.kind === 'fiveHour') return t('cli.windowFiveHour')
  if (window.kind === 'weekly') return t('cli.windowWeekly')
  if (window.kind === 'monthly') return t('cli.windowMonthly')
  if (window.kind === 'weeklyModel') return window.scope ?? t('cli.windowWeekly')
  return t('time.minutes', { count: window.windowMinutes })
}
