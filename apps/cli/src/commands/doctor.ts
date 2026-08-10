import type { DoctorReport } from '@agentmeter/core'
import { t } from '@agentmeter/core'
import { formatNumber, table } from '../format.ts'

export function renderDoctor(
  report: DoctorReport,
  locale: string,
  configProblems: readonly string[],
): string {
  const lines: string[] = [
    t('cli.indexPath', { path: report.indexPath || '—' }),
    t('cli.schema', { version: report.schemaVersion }),
  ]
  if (report.emptyIndex) {
    lines.push(t('cli.emptyIndex'))
  } else {
    lines.push(
      t('cli.sources', {
        sources: formatNumber(report.sources, locale),
        sessions: formatNumber(report.sessions!, locale),
        requests: formatNumber(report.requests!, locale),
      }),
      t('cli.reconstructedSessions', {
        sessions: formatNumber(report.reconstructedSessions, locale),
      }),
    )
    // Строка появляется, только когда провайдер уже что-то удалил: «логов,
    // которых нет: 0» — это не новость, а шум в отчёте, который читают ради
    // проблем.
    if (report.vanishedSources > 0) {
      lines.push(
        t('cli.vanishedSources', { sources: formatNumber(report.vanishedSources, locale) }),
      )
    }
  }
  lines.push(
    '',
    t('cli.calibration'),
    t('cli.cacheReadWeight', {
      value: report.calibration.cacheReadWeight ?? t('cli.notCalibrated'),
    }),
    t('cli.fiveHourCap', { value: report.calibration.fiveHourCap ?? t('cli.notSet') }),
    t('cli.weeklyCap', { value: report.calibration.weeklyCap ?? t('cli.notSet') }),
  )
  if (configProblems.length > 0) lines.push('', t('cli.configProblems'), ...configProblems)
  if (report.diagnostics.length > 0) {
    lines.push(
      '',
      t('cli.diagnostics'),
      table(
        [
          { header: t('cli.columnKind'), width: 22 },
          { header: t('cli.columnDetail'), width: 30 },
          { header: 'CLI', width: 12 },
          { header: t('cli.columnCount'), width: 7, align: 'right' },
        ],
        report.diagnostics.map((row) => [
          row.kind,
          row.detail,
          row.cliVersion ?? '—',
          formatNumber(row.count, locale),
        ]),
      ),
    )
  }
  return lines.join('\n')
}
