/**
 * Единый формат числа токенов — один на CLI и на попап.
 *
 * До 2.5 форматтеров было два: `apps/cli/src/format.ts` брал локаль из
 * конфига, а `apps/desktop/src/renderer/format.ts` держал зашитый `en-US` и
 * строчный суффикс. На одной машине одно и то же число читалось как `344.9M`
 * в окне и `344,9M` в терминале — для измерительного продукта это ровно тот
 * разряд вранья, которого нельзя допускать: пользователь видит два числа и не
 * знает, какое настоящее.
 *
 * Суффикс тысяч — строчный `k`, как в макете (`38k`, `14.8k`). Эталон здесь
 * макет, поэтому к нему приводится CLI, а не наоборот.
 *
 * Разделитель дробной части приходит из локали, и при `ru` попап покажет
 * `344,9M` там, где в макете нарисовано `344.9M`. Это принято сознательно:
 * макет рисовался до появления локали в конфиге, и подменять локаль ради
 * совпадения с картинкой значит врать пользователю про его же настройки.
 *
 * Модуль намеренно не тянет ничего из ядра: рендерер импортирует его напрямую,
 * а любой импорт через `index.ts` привёл бы в браузерный бандл `node:sqlite`.
 */

const UNITS = [
  { size: 1_000_000_000, suffix: 'B' },
  { size: 1_000_000, suffix: 'M' },
  { size: 1_000, suffix: 'k' },
] as const

/**
 * Число со словом в нужном падеже: «1 сессия», «22 сессии», «8 проектов».
 *
 * Живёт рядом с форматом токенов и по той же причине: считающих по-русски мест
 * должно быть одно. С 3.4 фразу с суждением собирает main (`timelineNote`,
 * `note` карточки), и написать там второй набор правил склонения значило бы
 * получить «2 запроса» в окне и «2 запросов» в подсказке из main на одном
 * экране. Формы перечисляются в порядке `Intl.PluralRules` — one/few/many.
 */
export function plural(
  value: number,
  forms: readonly [string, string, string],
  locale: string,
): string {
  const category = new Intl.PluralRules(locale).select(value)
  const index = category === 'one' ? 0 : category === 'few' ? 1 : 2
  return `${new Intl.NumberFormat(locale).format(value)} ${forms[index] ?? forms[2]}`
}

export function formatTokens(value: number, locale: string): string {
  for (const unit of UNITS) {
    if (Math.abs(value) < unit.size) continue
    const scaled = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
      value / unit.size,
    )
    return `${scaled}${unit.suffix}`
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}
