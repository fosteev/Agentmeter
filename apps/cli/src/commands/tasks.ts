import type { TaskRow } from '@agentmeter/core'
import { t } from '@agentmeter/core'
import { formatDuration, formatTime, formatTokens, table } from '../format.ts'

export function renderTasks(
  rows: readonly TaskRow[],
  state: { emptyIndex: boolean; rangeFrom: number; locale: string },
): string {
  if (state.emptyIndex) return t('cli.emptyIndex')
  if (rows.length === 0) {
    const date = new Intl.DateTimeFormat(state.locale, {
      day: 'numeric',
      month: 'long',
    }).format(state.rangeFrom)
    return t('cli.emptyDate', { date })
  }
  return table(
    [
      { header: t('cli.columnTime'), width: 5 },
      { header: t('cli.columnDuration'), width: 7 },
      { header: t('cli.columnProject'), width: 10 },
      { header: t('cli.columnModel'), width: 12 },
      { header: t('cli.columnTask'), width: 13 },
      { header: t('cli.columnTokens'), width: 7, align: 'right' },
      { header: t('cli.columnTools'), width: 4, align: 'right' },
      { header: t('cli.columnAgents'), width: 4, align: 'right' },
    ],
    rows.map((row) => [
      formatTime(row.startedAt, state.locale),
      formatDuration(row.durationMs, state.locale),
      row.branch ? `${row.project}:${row.branch}` : row.project,
      row.model,
      // Запасное имя подставляет тот, кто печатает: колонке нужна строка, а в
      // модели «названия нет» — отдельный случай, который рисуют иначе (3.1).
      `${row.approximate ? '≈' : ''}${row.title ?? row.firstPrompt ?? t('cli.untitled')}`,
      formatTokens(row.totals.total, state.locale),
      String(row.toolCalls),
      String(row.children.length),
    ]),
  )
}
