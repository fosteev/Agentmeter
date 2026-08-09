import type { TodayReport } from '@agentmeter/core'
import { formatDate, formatNumber, formatTokens, plural, table } from '../format.ts'

export function renderToday(report: TodayReport, locale: string): string {
  if (report.emptyIndex) return 'индекс пуст, запустите `agentmeter index`'
  if (report.emptyDay) return `за ${formatDate(report.range.from, locale)} записей нет`
  const totals = report.totals!
  const approximate = report.approximate ? '≈' : ''
  const lines = [
    `${formatDate(report.range.from, locale)} · ${approximate}${formatTokens(totals.total, locale)} токенов · ` +
      `${plural(totals.requests, locale, ['запрос', 'запроса', 'запросов'])} · ` +
      `${plural(report.tasks!, locale, ['задача', 'задачи', 'задач'])}`,
    `input ${formatTokens(totals.input, locale)} · output ${formatTokens(totals.output, locale)} · cache write ${formatTokens(totals.cacheWrite, locale)} · cache read ${formatTokens(totals.cacheRead, locale)}`,
  ]
  for (const [title, rows] of [
    ['Провайдеры', report.providers],
    ['Модели', report.models],
    ['Проекты', report.projects],
  ] as const) {
    lines.push(
      '',
      title,
      table(
        [
          { header: 'Имя', width: 38 },
          { header: 'Токены', width: 12, align: 'right' },
          { header: 'Запросы', width: 8, align: 'right' },
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
    'По часам',
    table(
      [
        { header: 'Час', width: 5 },
        { header: 'Токены', width: 12, align: 'right' },
        { header: 'Запросы', width: 8, align: 'right' },
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
