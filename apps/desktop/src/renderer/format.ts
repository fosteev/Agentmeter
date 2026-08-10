/**
 * Формат чисел и дат рендерера — тонкая обёртка над общим форматтером ядра.
 *
 * Своей арифметики и своего договора здесь нет: и то и другое лежит в
 * `packages/core/src/format/tokens.ts`, и попап обязан показывать ровно те же
 * строки, что `agentmeter today` на той же машине. Импорт идёт подпутём
 * `@agentmeter/core/format`, а не через `index.ts`: барель тянет `node:sqlite`,
 * которому в браузерном бандле нечего делать.
 *
 * Локаль хранится не здесь: с 3.8 она одна на процесс и живёт в каталогах
 * (`@agentmeter/core/i18n`) — иначе число форматировалось бы по одной локали, а
 * слово рядом с ним переводилось бы по другой. `setLocale` здесь остался точкой
 * входа, потому что рендерер и так зовёт его при монтировании.
 */
import { formatTokens as format } from '@agentmeter/core/format'
import { locale, setLocale as apply, type LocaleSetting } from '@agentmeter/core/i18n'

export { locale, t } from '@agentmeter/core/i18n'

/** Поставить язык на весь рендерер: и переводы, и числа с датами. */
export function setLocale(setting: LocaleSetting): void {
  apply(setting)
  cache.clear()
}

export function formatTokens(value: number): string {
  return format(value, locale())
}

/**
 * Даты и время: локаль одна на окно.
 *
 * Своё `new Intl.DateTimeFormat(...)` в компоненте выглядит безобидно ровно до
 * второго такого места — а дальше «09:12» в ленте и «09:12» в карточке начинают
 * расходиться на формат часа или на порядок дня с месяцем, и заметить это можно
 * только положив два экрана рядом. Форматтеры кэшируются: конструктор `Intl`
 * дорогой, а строк задач на экране два десятка; кэш сбрасывается вместе со
 * сменой языка, иначе после переключения даты остались бы на прежнем.
 */
const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${locale()}:${key}`
  const known = cache.get(id)
  if (known !== undefined) return known
  const made = new Intl.DateTimeFormat(locale(), options)
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
  return value.charAt(0).toLocaleUpperCase(locale()) + value.slice(1)
}
