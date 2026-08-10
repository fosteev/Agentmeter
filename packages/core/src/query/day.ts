import type { DayRange } from './types.ts'

/**
 * Границы дня с учётом `ui.dayStartsAtHour` в локальной зоне.
 *
 * День календарный: от начала одного дня до начала следующего, длина —
 * какая получится. Ровно 24 часа держать нельзя: дважды в год на переводе
 * часов сутки длятся 23 или 25, и фиксированная длина заставляет соседние
 * дни перекрываться на час или расходиться на час. В первом случае расход
 * этого часа считается дважды, во втором пропадает — и то и другое молча.
 */
export function dayRange(at: number, dayStartsAtHour: number, offsetDays = 0): DayRange {
  if (!Number.isInteger(dayStartsAtHour) || dayStartsAtHour < 0 || dayStartsAtHour > 23) {
    throw new RangeError('час начала дня должен быть целым числом от 0 до 23')
  }
  if (!Number.isInteger(offsetDays)) throw new RangeError('смещение дня должно быть целым числом')

  return {
    from: dayStart(at, dayStartsAtHour, offsetDays),
    to: dayStart(at, dayStartsAtHour, offsetDays + 1),
  }
}

function dayStart(at: number, dayStartsAtHour: number, offsetDays: number): number {
  const date = new Date(at)
  date.setHours(dayStartsAtHour, 0, 0, 0)
  if (at < date.getTime()) date.setDate(date.getDate() - 1)
  date.setDate(date.getDate() + offsetDays)
  return date.getTime()
}
