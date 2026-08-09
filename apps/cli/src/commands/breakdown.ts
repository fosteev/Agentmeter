import type { BreakdownReport } from '@agentmeter/core'
import { formatNumber, formatTokens, table } from '../format.ts'

export type BreakdownAxis = 'tool' | 'server' | 'skill' | 'agent' | 'model'

export function renderBreakdown(
  report: BreakdownReport,
  axis: BreakdownAxis,
  locale: string,
): string {
  if (report.emptyIndex) return 'индекс пуст, запустите `agentmeter index`'
  if (report.emptyScope) return 'в выбранном диапазоне записей нет'
  if (axis === 'tool') {
    return table(
      [
        { header: 'Инструмент', width: 28 },
        { header: 'Измерено', width: 11, align: 'right' },
        { header: 'Делёж', width: 11, align: 'right' },
        { header: 'Неизвестно', width: 11, align: 'right' },
        { header: 'Вызовы', width: 7, align: 'right' },
      ],
      report.tool.map((row) => [
        row.key,
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
        { header: 'MCP-сервер', width: 40 },
        { header: 'Токены', width: 14, align: 'right' },
        { header: 'Вызовы', width: 10, align: 'right' },
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
      { header: 'Токены', width: 14, align: 'right' },
      { header: 'Запросы', width: 10, align: 'right' },
    ],
    report[axis].map((row) => [
      row.key,
      formatTokens(row.totals.total, locale),
      formatNumber(row.totals.requests, locale),
    ]),
  )
}

function axisTitle(axis: Exclude<BreakdownAxis, 'tool' | 'server'>): string {
  if (axis === 'skill') return 'Скилл'
  if (axis === 'agent') return 'Агент'
  return 'Модель'
}
