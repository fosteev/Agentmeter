/**
 * Какие языки есть и какой показывать.
 *
 * Отдельным файлом от `index.ts` ради конфига: `config/types.ts` берёт отсюда
 * тип настройки, и тащить ради одного типа i18next в модуль, который читают все,
 * незачем.
 */

/** Языки, у которых есть каталог. */
export const LOCALES = ['ru', 'en'] as const
export type Locale = (typeof LOCALES)[number]
/** Что лежит в конфиге. `system` — «спросить у системы». */
export type LocaleSetting = Locale | 'system'

/**
 * Какой язык показывать.
 *
 * `system` — из окружения, с откатом на **английский**: каталог на нём полный,
 * а незнакомый язык интерфейса читается хуже неродного, но знакомого. До 3.8 в
 * конфиге лежало зашитое `ru`, то есть человек с английской системой видел
 * русский интерфейс и не имел способа догадаться, откуда он взялся.
 */
export function resolveLocale(setting: LocaleSetting, system = systemLocale()): Locale {
  if (setting !== 'system') return setting
  const language = system.toLowerCase().split(/[-_]/)[0]
  return LOCALES.find((locale) => locale === language) ?? 'en'
}

function systemLocale(): string {
  // `Intl` есть и в Node, и в Electron, и в браузере — отдельного пути для
  // каждого не нужно. `LANG` из окружения не читаем: в macOS-приложении,
  // запущенном из Dock, его нет вовсе.
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
}
