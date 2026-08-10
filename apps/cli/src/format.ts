import { formatTokens, t } from '@agentmeter/core'

export interface Column {
  header: string
  width?: number
  align?: 'left' | 'right'
}

/**
 * Формат токенов общий с попапом — `packages/core/src/format/tokens.ts`.
 *
 * Здесь он раньше жил своей копией с суффиксом `K`, а в рендерере — своей с
 * зашитым `en-US`. Две копии одного договора разошлись бы на первой правке, и
 * пользователь увидел бы два разных числа на одной машине.
 */
export { formatTokens }

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/**
 * Единицы времени берутся из каталога (`time.*`) — тех же, что показывает
 * попап. Свои «мин» и «ч» здесь означали бы, что на одной машине терминал и
 * окно сокращают одно и то же слово по-разному.
 */
export function formatDuration(ms: number, _locale?: string): string {
  if (ms <= 0) return t('time.minutes', { count: 0 })
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? t('time.hours', { count: hours })
    : t('time.hoursMinutes', { hours, minutes: rest })
}

export function formatDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at)
}

export function formatTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
}

export function table(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '—'
  const widths = columns.map((column, index) => {
    const content = Math.max(
      column.header.length,
      ...rows.map((row) => visibleLength(row[index] ?? '')),
    )
    return Math.min(column.width ?? content, content)
  })
  const render = (row: readonly string[]) =>
    row
      .map((cell, index) => {
        const width = widths[index] ?? 0
        const clipped = clip(cell, width)
        return columns[index]?.align === 'right' ? clipped.padStart(width) : clipped.padEnd(width)
      })
      .join('  ')
      .trimEnd()
  return [
    render(columns.map((column) => column.header)),
    render(widths.map((width) => '─'.repeat(width))),
    ...rows.map(render),
  ].join('\n')
}

function clip(value: string, width: number): string {
  if (visibleLength(value) <= width) return value
  if (width <= 1) return '…'.slice(0, width)
  return `${value.slice(0, width - 1)}…`
}

function visibleLength(value: string): number {
  return [...value].length
}
