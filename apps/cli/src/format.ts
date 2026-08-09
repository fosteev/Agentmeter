export interface Column {
  header: string
  width?: number
  align?: 'left' | 'right'
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

export function formatTokens(value: number, locale: string): string {
  const units = [
    { size: 1_000_000_000, suffix: 'B' },
    { size: 1_000_000, suffix: 'M' },
    { size: 1_000, suffix: 'K' },
  ]
  for (const unit of units) {
    if (Math.abs(value) < unit.size) continue
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / unit.size)}${unit.suffix}`
  }
  return formatNumber(value, locale)
}

/**
 * Число со словом в нужном падеже: «1 задача», «2 задачи», «23 задачи».
 *
 * Формы задаются в порядке `Intl.PluralRules` для русского — one/few/many;
 * для локали с двумя формами хватит первых двух.
 */
export function plural(value: number, locale: string, forms: readonly string[]): string {
  const category = new Intl.PluralRules(locale).select(value)
  const index = category === 'one' ? 0 : category === 'few' ? 1 : 2
  const word = forms[index] ?? forms.at(-1) ?? ''
  return `${formatNumber(value, locale)} ${word}`
}

export function formatDuration(ms: number, locale: string): string {
  if (ms <= 0) return '0 мин'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${formatNumber(minutes, locale)} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`
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
