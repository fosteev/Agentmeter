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
import { formatTokens as format } from '@agentmeter/core/format'

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
 * Формы перечисляются в порядке `Intl.PluralRules` — one/few/many. Руками
 * писать правила русского счёта не надо: на 11 и 111 они разные, и ошибку
 * никто не заметит месяцами.
 */
export function plural(value: number, forms: readonly [string, string, string]): string {
  const category = new Intl.PluralRules(current).select(value)
  const index = category === 'one' ? 0 : category === 'few' ? 1 : 2
  return `${new Intl.NumberFormat(current).format(value)} ${forms[index] ?? forms[2]}`
}
