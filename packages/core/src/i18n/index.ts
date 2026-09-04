/**
 * Тексты интерфейса — один каталог на main, окно и CLI (3.8).
 *
 * Модуль не тянет ничего из ядра, и это то же решение, что у `format/tokens.ts`:
 * рендерер импортирует его напрямую (`@agentmeter/core/i18n`), а импорт через
 * барель привёл бы в браузерный бандл `node:sqlite`.
 *
 * **Локаль одна на процесс, а не проп.** Причина приземлённая: главное окно,
 * попап и подсказка из main показываются одновременно, и локаль у них обязана
 * быть одна. Протаскивание её параметром даёт столько мест, где однажды забудут
 * передать, сколько в приложении вызовов `t()`.
 *
 * **Язык по умолчанию берётся у системы.** До 3.8 в конфиге лежало зашитое
 * `ru`, то есть человек с английской системой видел русский интерфейс и не имел
 * способа об этом догадаться. Теперь `locale: 'system'` — значение по
 * умолчанию, а разрешается оно здесь: русский, если система русская, иначе
 * английский. Третий язык добавится каталогом, а не правкой этой функции.
 */
import i18next, { type i18n as I18n } from 'i18next'
// Импорт ради самой проверки: полнота каталогов держится присваиванием типов
// внутри `check.ts`, и без ссылки на модуль он в сборку не попадёт.
import './check.ts'
import type { LimitWindowKind } from '../sources/types.ts'
import { en } from './en.ts'
import { resolveLocale, type Locale, type LocaleSetting } from './locale.ts'
import { ru } from './ru.ts'

export { en } from './en.ts'
export { ru } from './ru.ts'
export { LIMITS, type LimitedKey } from './limits.ts'
export { LOCALES, resolveLocale, type Locale, type LocaleSetting } from './locale.ts'

const RESOURCES = {
  ru: { translation: ru },
  en: { translation: en },
} as const

/**
 * Типизация ключей: `t()` принимает только то, что есть в русском каталоге, а
 * английский обязан покрыть те же логические ключи (`check.ts`).
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof ru }
    returnNull: false
  }
}

/**
 * Каталоги поднимаются при загрузке модуля, а не по вызову из каждого процесса.
 *
 * Иначе `t()` пришлось бы делать обёрткой с ленивой инициализацией, а обёртка
 * над перегруженной сигнатурой теряет типизацию ключей — ровно то свойство,
 * ради которого выбран i18next. Ресурсы лежат в коде, инициализация
 * синхронная, стоит она микросекунды.
 */
const instance: I18n = i18next.createInstance()
void instance.init({
  lng: resolveLocale('system'),
  // Откат на английский, а не на ключ: ключ в интерфейсе — это мусор, который
  // выглядит поломкой, хотя перевод всего лишь не дописан.
  fallbackLng: 'en',
  resources: RESOURCES,
  interpolation: { escapeValue: false },
})

/**
 * Перевод по ключу. Подстановки именованные: порядок слов в языках разный, и
 * позиционные `%s` переставить нельзя.
 *
 * Это `t` самого экземпляра, а не обёртка: он смотрит на текущий язык при
 * каждом вызове, поэтому переживает `setLocale` без перепривязки в компонентах.
 */
export const t = instance.t

/**
 * Переключить язык. Зовётся при старте процесса и при смене настройки (3.6
 * меняет её без перезапуска окна).
 */
export function setLocale(setting: LocaleSetting): Locale {
  const next = resolveLocale(setting)
  void instance.changeLanguage(next)
  return next
}

/** Текущий язык. */
export function locale(): Locale {
  return instance.language as Locale
}

/** Вид окна → ключ каталога. Ключи, а не слова: `t()` на верхнем уровне застыл
 *  бы на языке загрузки. */
const WINDOW_KEY = {
  fiveHour: 'limit.fiveHour',
  weekly: 'limit.weekly',
  monthly: 'limit.monthly',
  other: 'limit.other',
  weeklyModel: 'limit.weeklyModel',
} as const satisfies Record<LimitWindowKind, string>

/**
 * Имя окна лимита — одной функцией на попап, экран паузы и уведомления (7.9).
 *
 * До 7.9 у каждого из трёх лежала своя копия таблицы «вид → ключ», и это
 * работало ровно пока видов было четыре и все безымянные. С модельным окном
 * копии стали разными: имя ему даёт не вид, а модель из ответа провайдера, и
 * забытая копия показала бы «окно лимита» там, где написано «Fable · неделя».
 *
 * Тип `LimitWindowKind` приходит из ядра **типом**: импорт стирается сборкой, и
 * модуль по-прежнему не тянет за собой `node:sqlite` (шапка файла).
 */
export function windowTitle(window: { kind: LimitWindowKind; scope?: string | undefined }): string {
  if (window.kind !== 'weeklyModel') return t(WINDOW_KEY[window.kind])
  // Модельное окно без имени модели в ответе не встречается: разбор без имени
  // его не пропускает (`limits/oauth.ts`). Но если такое приедет, общее имя
  // честнее пустого места — и оно отличается от «недельного окна» соседа.
  return window.scope === undefined
    ? t('limit.weeklyModelAny')
    : t('limit.weeklyModel', { model: window.scope })
}
