import type { DayRange } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Границы дня с учётом ui.dayStartsAtHour в локальной зоне. */
export function dayRange(at: number, dayStartsAtHour: number, offsetDays = 0): DayRange {
  if (!Number.isInteger(dayStartsAtHour) || dayStartsAtHour < 0 || dayStartsAtHour > 23) {
    throw new RangeError('час начала дня должен быть целым числом от 0 до 23')
  }
  if (!Number.isInteger(offsetDays)) throw new RangeError('смещение дня должно быть целым числом')

  const date = new Date(at)
  date.setHours(dayStartsAtHour, 0, 0, 0)
  if (at < date.getTime()) date.setDate(date.getDate() - 1)
  date.setDate(date.getDate() + offsetDays)
  const from = date.getTime()
  // По контракту продуктовый день всегда длится 24 часа; переходы DST не
  // должны незаметно дать пользователю 23 или 25 часов расхода.
  return { from, to: from + DAY_MS }
}
