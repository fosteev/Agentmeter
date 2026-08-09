import type { DoctorReport } from '@agentmeter/core'
import { formatNumber, table } from '../format.ts'

export function renderDoctor(
  report: DoctorReport,
  locale: string,
  configProblems: readonly string[],
): string {
  const lines = [`Индекс: ${report.indexPath || '—'}`, `Схема: ${report.schemaVersion}`]
  if (report.emptyIndex) {
    lines.push('индекс пуст, запустите `agentmeter index`')
  } else {
    lines.push(
      `Источники: ${formatNumber(report.sources, locale)} · сессии: ${formatNumber(report.sessions!, locale)} · запросы: ${formatNumber(report.requests!, locale)}`,
      `Сессии с измеренной поправкой: ${formatNumber(report.reconstructedSessions, locale)}`,
    )
  }
  lines.push(
    '',
    'Калибровка',
    `cache_read: ${report.calibration.cacheReadWeight ?? '— (не откалиброван, этап 1.9)'}`,
    `пятичасовой потолок: ${report.calibration.fiveHourCap ?? '— (не задан)'}`,
    `недельный потолок: ${report.calibration.weeklyCap ?? '— (не задан)'}`,
  )
  if (configProblems.length > 0) lines.push('', 'Проблемы конфига', ...configProblems)
  if (report.diagnostics.length > 0) {
    lines.push(
      '',
      'Диагностика',
      table(
        [
          { header: 'Вид', width: 22 },
          { header: 'Деталь', width: 30 },
          { header: 'CLI', width: 12 },
          { header: 'Число', width: 7, align: 'right' },
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
