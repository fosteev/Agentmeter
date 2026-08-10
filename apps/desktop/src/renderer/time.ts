/**
 * Время в попапе словами. Числа маленькие, а форматов три, и все три в макете.
 *
 * Общего с CLI здесь нет: там таблица и колонка «В работе» с единственным
 * форматом «N мин», а попапу нужны «2 с назад» в шапке, «4 мин» в строке агента
 * и «6 д 4 ч» под полосой лимита. Сводить их в один форматтер значит выдумывать
 * четвёртый формат, которого нет ни там, ни там.
 *
 * Всё считается от `TraySnapshot.at`, а не от часов рендерера: снимок мог ехать
 * до окна сотни миллисекунд, а на спящей машине — минуты, и «обновлено 0 с
 * назад» на протухших данных врёт ровно про то, ради чего эта строка есть.
 */

import { t } from '@agentmeter/core/i18n'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** «2 с назад», «4 мин назад», «3 ч назад». */
export function ago(ms: number): string {
  if (ms < MINUTE) return t('time.secondsAgo', { count: Math.max(0, Math.floor(ms / SECOND)) })
  if (ms < HOUR) return t('time.minutesAgo', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return t('time.hoursAgo', { count: Math.floor(ms / HOUR) })
  return t('time.daysAgo', { count: Math.floor(ms / DAY) })
}

/** «4 мин», «1 ч 20 мин», «2 д». Меньше минуты — «меньше минуты». */
export function span(ms: number): string {
  if (ms < MINUTE) return t('time.lessThanMinute')
  if (ms < HOUR) return t('time.minutes', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes === 0 ? t('time.hours', { count: hours }) : t('time.hoursMinutes', { hours, minutes })
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  return hours === 0 ? t('time.days', { count: days }) : t('time.daysHours', { days, hours })
}
