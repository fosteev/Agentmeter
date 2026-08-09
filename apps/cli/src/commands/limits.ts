import type { LimitsReport } from '@agentmeter/core'
import { formatDuration, table } from '../format.ts'

export function renderLimits(report: LimitsReport, locale: string): string {
  if (report.emptyIndex) return 'индекс пуст, запустите `agentmeter index`'
  if (report.windows.length === 0) return 'текущих окон лимита нет'
  return table(
    [
      { header: 'Провайдер', width: 10 },
      { header: 'Окно', width: 12 },
      { header: 'Расход', width: 28 },
      { header: 'До сброса', width: 12 },
      { header: 'Основа', width: 8 },
    ],
    report.windows.map((window) => [
      window.provider,
      kindName(window.kind, window.windowMinutes),
      window.usedPercent === null
        ? `— (${window.unavailableReason ?? 'неизвестно'})`
        : `${window.exact ? '' : '≈'}${window.usedPercent}%`,
      formatDuration(window.resetsAt - report.at, locale),
      window.exact ? 'точно' : 'оценка',
    ]),
  )
}

function kindName(kind: string, minutes: number): string {
  if (kind === 'fiveHour') return '5 часов'
  if (kind === 'weekly') return 'неделя'
  if (kind === 'monthly') return 'месяц'
  return `${minutes} мин`
}
