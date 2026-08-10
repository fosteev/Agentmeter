import type { TaskRow } from '@agentmeter/core'
import { formatDuration, formatTime, formatTokens, table } from '../format.ts'

export function renderTasks(
  rows: readonly TaskRow[],
  state: { emptyIndex: boolean; rangeFrom: number; locale: string },
): string {
  if (state.emptyIndex) return 'индекс пуст, запустите `agentmeter index`'
  if (rows.length === 0) {
    const date = new Intl.DateTimeFormat(state.locale, {
      day: 'numeric',
      month: 'long',
    }).format(state.rangeFrom)
    return `за ${date} записей нет`
  }
  return table(
    [
      { header: 'Время', width: 5 },
      { header: 'Длительность', width: 7 },
      { header: 'Проект', width: 10 },
      { header: 'Модель', width: 12 },
      { header: 'Задача', width: 13 },
      { header: 'Токены', width: 7, align: 'right' },
      { header: 'Тулы', width: 4, align: 'right' },
      { header: 'Агенты', width: 4, align: 'right' },
    ],
    rows.map((row) => [
      formatTime(row.startedAt, state.locale),
      formatDuration(row.durationMs, state.locale),
      row.branch ? `${row.project}:${row.branch}` : row.project,
      row.model,
      // Запасное имя подставляет тот, кто печатает: колонке нужна строка, а в
      // модели «названия нет» — отдельный случай, который рисуют иначе (3.1).
      `${row.approximate ? '≈' : ''}${row.title ?? row.firstPrompt ?? 'без названия'}`,
      formatTokens(row.totals.total, state.locale),
      String(row.toolCalls),
      String(row.subagents),
    ]),
  )
}
