import { describe, expect, it } from 'vitest'
import { LIMITS, LOCALES, resolveLocale, setLocale, t, type LimitedKey } from '../src/i18n/index.ts'
import { en } from '../src/i18n/en.ts'
import { ru } from '../src/i18n/ru.ts'

/**
 * Каталоги и потолки длины (3.8).
 *
 * Полнота каталогов проверяется типом (`i18n/check.ts`) — четыре мутации
 * каталога дают четыре ошибки компиляции, и повторять это тестом незачем.
 * Здесь проверяется то, чего тип не видит: **длина** готовой фразы и выбор
 * языка по системе.
 *
 * Проверки названы по поломке, которую ловят.
 */

/**
 * Типичные подстановки для ключей с потолком.
 *
 * Потолок ставится на готовую фразу, а не на шаблон: за край вылезает именно
 * она. Значения взяты правдоподобные и **длинные из встречающихся** — «2 мин
 * назад» уложится в любой потолок, а мерить надо худший случай, который бывает
 * каждый день.
 */
const VALUES: Record<string, Record<string, string | number>> = {
  'state.finishedAgo': { ago: '18 мин назад' },
  'limit.resetsIn': { span: '4 ч 37 мин' },
  'limit.untilCap': { reset: 'сброс через 4 ч', span: '52 мин' },
  'limit.idleWindow': { span: '4 ч 37 мин' },
  'card.files': { count: 128 },
}

describe('потолки длины', () => {
  /**
   * Ловит потолок, поставленный на ключ, которого в каталоге нет: опечатка в
   * `LIMITS` превратила бы проверку в пустую — она бы мерила длину самого
   * ключа и всегда проходила.
   */
  it('каждый потолок стоит на существующем ключе', () => {
    for (const key of Object.keys(LIMITS) as LimitedKey[]) {
      const [section, name] = key.split('.') as [keyof typeof ru, string]
      const catalog = ru[section] as Record<string, string>
      const found = Object.keys(catalog).some(
        (candidate) => candidate === name || candidate.startsWith(`${name}_`),
      )
      expect(found, key).toBe(true)
    }
  })

  /**
   * Ловит перевод, выдавивший число за край.
   *
   * Вторая строка `AgentRow` занимает 367 пикселей из 372 (замер 2.6) — это не
   * запас, а впритык, и английский короче не везде: «завершился 2 мин назад»
   * против «finished 2 min ago» длиннее. Ломается это молча и только на одном
   * языке из двух, то есть ровно так, как замечают через месяц.
   */
  it('обе локали укладываются в потолок', () => {
    for (const locale of LOCALES) {
      setLocale(locale)
      for (const [key, limit] of Object.entries(LIMITS)) {
        const value = t(key as LimitedKey, VALUES[key] ?? {})
        expect(value.length, `${locale} · ${key} · «${value}»`).toBeLessThanOrEqual(limit)
      }
    }
    setLocale('ru')
  })

  /**
   * Ловит подстановку, потерянную в переводе: `{{span}}`, не заменённый
   * значением, доезжает до экрана как есть, а длина при этом даже уменьшается —
   * потолок такое пропустит.
   */
  it('в переведённой фразе не остаётся подстановок', () => {
    for (const locale of LOCALES) {
      setLocale(locale)
      for (const key of Object.keys(LIMITS) as LimitedKey[]) {
        expect(t(key, VALUES[key] ?? {})).not.toContain('{{')
      }
    }
    setLocale('ru')
  })
})

describe('выбор языка', () => {
  /**
   * Ловит язык, зашитый в код. До 3.8 в конфиге лежало `ru`, и человек с
   * английской системой видел русский интерфейс, не имея способа догадаться,
   * откуда он взялся.
   */
  it('система решает только при `system`, откат — английский', () => {
    expect(resolveLocale('system', 'ru-RU')).toBe('ru')
    expect(resolveLocale('system', 'ru')).toBe('ru')
    expect(resolveLocale('system', 'en-GB')).toBe('en')
    expect(resolveLocale('system', 'de-DE')).toBe('en')
    expect(resolveLocale('system', '')).toBe('en')
    expect(resolveLocale('ru', 'en-US')).toBe('ru')
    expect(resolveLocale('en', 'ru-RU')).toBe('en')
  })

  /**
   * Ловит счёт по одному языку на всех: правила множественного числа у русского
   * и английского разные, и «1 запросов» получается ровно из того, что формы
   * взяли не у того языка.
   */
  it('формы множественного числа берутся у языка, а не у первого попавшегося', () => {
    setLocale('ru')
    expect(t('today.requests', { count: 1 })).toBe('1 запрос')
    expect(t('today.requests', { count: 3 })).toBe('3 запроса')
    expect(t('today.requests', { count: 11 })).toBe('11 запросов')
    expect(t('today.requests', { count: 22 })).toBe('22 запроса')

    setLocale('en')
    expect(t('today.requests', { count: 1 })).toBe('1 request')
    expect(t('today.requests', { count: 3 })).toBe('3 requests')
    expect(t('today.requests', { count: 11 })).toBe('11 requests')
    setLocale('ru')
  })

  /**
   * Ловит термин, переведённый мимо глоссария. Половина слов продукта уже
   * написана провайдером в логах (`cache read`, `cache write`), и второй словарь
   * поверх существующего врёт не хуже цифры.
   */
  it('английские термины совпадают с тем, как их пишет провайдер', () => {
    expect(en.tokens.cacheRead).toBe('cache read')
    expect(en.tokens.cacheWrite).toBe('cache write')
    expect(en.tokens.output).toBe('output')
    expect(en.limit.fiveHour).toContain('5-hour')
  })
})
