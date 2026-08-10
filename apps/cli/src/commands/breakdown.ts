import type { BreakdownReport } from '@agentmeter/core'
import { t, toolRowLabel } from '@agentmeter/core'
import { formatNumber, formatTokens, table } from '../format.ts'

export type BreakdownAxis = 'tool' | 'server' | 'skill' | 'agent' | 'model'

export function renderBreakdown(
  report: BreakdownReport,
  axis: BreakdownAxis,
  locale: string,
): string {
  if (report.emptyIndex) return t('cli.emptyIndex')
  if (report.emptyScope) return t('cli.emptyRange')
  if (axis === 'tool') {
    return table(
      [
        { header: t('cli.columnTool'), width: 28 },
        { header: t('cli.columnMeasured'), width: 11, align: 'right' },
        { header: t('cli.columnSplit'), width: 11, align: 'right' },
        { header: t('cli.columnUnknown'), width: 11, align: 'right' },
        { header: t('cli.columnCalls'), width: 7, align: 'right' },
      ],
      report.tool.map((row) => [
        toolRowLabel(row.key),
        formatTokens(row.tokens.measured, locale),
        formatTokens(row.tokens.split, locale),
        formatTokens(row.tokens.unknown, locale),
        formatNumber(row.calls.measured + row.calls.split + row.calls.unknown, locale),
      ]),
    )
  }
  if (axis === 'server') {
    return table(
      [
        { header: t('cli.columnServer'), width: 40 },
        { header: t('cli.columnTokens'), width: 14, align: 'right' },
        { header: t('cli.columnCalls'), width: 10, align: 'right' },
      ],
      report.server.map((row) => [
        row.key,
        formatTokens(row.tokens, locale),
        formatNumber(row.calls, locale),
      ]),
    )
  }
  return table(
    [
      { header: axisTitle(axis), width: 40 },
      { header: t('cli.columnTokens'), width: 14, align: 'right' },
      { header: t('cli.columnRequests'), width: 10, align: 'right' },
    ],
    report[axis].map((row) => [
      row.key,
      formatTokens(row.totals.total, locale),
      formatNumber(row.totals.requests, locale),
    ]),
  )
}

function axisTitle(axis: Exclude<BreakdownAxis, 'tool' | 'server'>): string {
  if (axis === 'skill') return t('cli.columnSkill')
  if (axis === 'agent') return t('cli.columnAgent')
  return t('cli.columnModel')
}
