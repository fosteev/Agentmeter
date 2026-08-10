// Формат токенов для рендерера. Повторяет договор из apps/cli/src/format.ts
// (maximumFractionDigits: 1, ступени B/M/k), но суффикс тысячи — строчный «k»,
// как в макете («38k», «14.8k»); десятичный разделитель — точка (en-US).
// Пока это местный формат рендерера; в 3.x он может объединиться с CLI.

const UNITS = [
  { size: 1_000_000_000, suffix: 'B' },
  { size: 1_000_000, suffix: 'M' },
  { size: 1_000, suffix: 'k' },
] as const

export function formatTokens(value: number): string {
  for (const unit of UNITS) {
    if (Math.abs(value) < unit.size) continue
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value / unit.size)}${unit.suffix}`
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}
