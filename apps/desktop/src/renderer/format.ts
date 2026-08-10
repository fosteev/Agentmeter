/**
 * Формат чисел рендерера — тонкая обёртка над общим форматтером ядра.
 *
 * Своей арифметики и своего договора здесь больше нет: и то и другое лежит в
 * `packages/core/src/format/tokens.ts`, и попап обязан показывать ровно те же
 * строки, что `agentmeter today` на той же машине. Импорт идёт подпутём
 * `@agentmeter/core/format`, а не через `index.ts`: барель тянет `node:sqlite`,
 * которому в браузерном бандле нечего делать.
 *
 * Локаль хранится модулем, а не приходит пропом в каждый компонент. Причина
 * приземлённая: локаль на окно одна, живёт в конфиге и меняется вместе с ним,
 * а протаскивание её через шесть компонентов даёт шесть мест, где однажды
 * забудут передать — и число молча станет форматироваться дефолтом. Значение
 * ставится один раз при монтировании (`main.tsx`) и в витрине.
 */
import { formatTokens as format, plural as pluralize } from '@agentmeter/core/format'

let current = 'ru'

export function setLocale(locale: string): void {
  current = locale
}

export function locale(): string {
  return current
}

export function formatTokens(value: number): string {
  return format(value, current)
}

/**
 * Число со словом в нужном падеже: «1 сессия», «22 сессии», «8 проектов».
 *
 * Правила счёта лежат в общем форматтере ядра — с 3.4 склонять приходится и
 * main (`timelineNote`), а два набора правил на один экран однажды разойдутся
 * на 11 и 111, где формы разные и ошибку никто не заметит месяцами.
 */
export function plural(value: number, forms: readonly [string, string, string]): string {
  return pluralize(value, forms, current)
}

/**
 * Даты и время живут здесь по той же причине, что числа: локаль одна на окно.
 *
 * Своё `new Intl.DateTimeFormat(...)` в компоненте выглядит безобидно ровно до
 * второго такого места — а дальше «09:12» в ленте и «09:12» в карточке начинают
 * расходиться на формат часа или на порядок дня с месяцем, и заметить это можно
 * только положив два экрана рядом. Форматтеры кэшируются: конструктор `Intl`
 * дорогой, а строк задач на экране два десятка.
 */
const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${current}:${key}`
  const known = cache.get(id)
  if (known !== undefined) return known
  const made = new Intl.DateTimeFormat(current, options)
  cache.set(id, made)
  return made
}

/** «09:12» — время начала задачи в колонке «Начало». */
export function clock(at: number): string {
  return formatter('clock', { hour: '2-digit', minute: '2-digit' }).format(at)
}

/** «Пятница, 7 августа» — заголовок дня. С заглавной, как в макете. */
export function dayTitle(at: number): string {
  const value = formatter('day', { weekday: 'long', day: 'numeric', month: 'long' }).format(at)
  return value.charAt(0).toLocaleUpperCase(current) + value.slice(1)
}
