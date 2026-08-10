import type { TodayReport } from '@agentmeter/core'
import { t } from '@agentmeter/core'
import { formatDate, formatNumber, formatTokens, table } from '../format.ts'

export function renderToday(report: TodayReport, locale: string): string {
  if (report.emptyIndex) return t('cli.emptyIndex')
  if (report.emptyDay) return t('cli.emptyDate', { date: formatDate(report.range.from, locale) })
  const totals = report.totals!
  const approximate = report.approximate ? '≈' : ''
  const lines = [
    `${formatDate(report.range.from, locale)} · ` +
      `${t('cli.totalTokens', { approx: approximate, tokens: formatTokens(totals.total, locale) })} · ` +
      `${t('today.requests', { count: totals.requests })} · ` +
      `${t('cli.tasks', { count: report.tasks! })}`,
    `input ${formatTokens(totals.input, locale)} · output ${formatTokens(totals.output, locale)} · cache write ${formatTokens(totals.cacheWrite, locale)} · cache read ${formatTokens(totals.cacheRead, locale)}`,
  ]
  for (const [title, rows] of [
    [t('cli.sectionProviders'), report.providers],
    [t('cli.sectionModels'), report.models],
    [t('cli.sectionProjects'), report.projects],
  ] as const) {
    lines.push(
      '',
      title,
      table(
        [
          { header: t('cli.columnName'), width: 38 },
          { header: t('cli.columnTokens'), width: 12, align: 'right' },
          { header: t('cli.columnRequests'), width: 8, align: 'right' },
        ],
        rows.map((row) => [
          row.key,
          formatTokens(row.totals.total, locale),
          formatNumber(row.totals.requests, locale),
        ]),
      ),
    )
  }
  lines.push(
    '',
    t('cli.sectionByHour'),
    table(
      [
        { header: t('cli.columnHour'), width: 5 },
        { header: t('cli.columnTokens'), width: 12, align: 'right' },
        { header: t('cli.columnRequests'), width: 8, align: 'right' },
      ],
      report.hours.map((row) => [
        `${String(row.hour).padStart(2, '0')}:00`,
        formatTokens(row.totals.total, locale),
        formatNumber(row.totals.requests, locale),
      ]),
    ),
  )
  return lines.join('\n')
}
