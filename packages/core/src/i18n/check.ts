/**
 * Полнота каталогов — типом, а не глазами (3.8).
 *
 * Ради этого свойства и выбран i18next: недостающий перевод обязан быть ошибкой
 * сборки, а не пустым местом в интерфейсе, которое заметит пользователь. Прямое
 * `typeof ru` для английского не годится — формы множественного числа у языков
 * разные: у русского `_one/_few/_many`, у английского `_one/_other`. Подгонять
 * английский под чужую грамматику значит завести в каталоге мёртвые ключи,
 * которые переводчик заполнит, а показать их некому.
 *
 * Поэтому сравниваются **логические** ключи: суффикс формы отбрасывается, и
 * `today.foldedTail_few` в русском и `today.foldedTail_other` в английском —
 * это один ключ `today.foldedTail`.
 *
 * Проверка нарочно не рекурсивная. Первая версия собирала плоский список путей
 * через точку одним рекурсивным типом — и на 380 ключах TypeScript сдавался с
 * `TS2589: Type instantiation is excessively deep`, то есть падал на **верных**
 * каталогах. Проверка, красная всегда, ничем не лучше зелёной всегда. Каталог
 * ровно двухуровневый (`Catalog` это требует), и обхода вглубь не нужно вовсе.
 */
import { en } from './en.ts'
import { ru } from './ru.ts'

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/** `foldedTail_few` → `foldedTail`, всё остальное — как есть. */
type Base<K extends string> = K extends `${infer Head}_${PluralSuffix}` ? Head : K

/** Двухуровневость — часть контракта каталога, а не случайность его формы. */
type Catalog = Record<string, Record<string, string>>

/** Оба каталога обязаны быть плоскими в два уровня; третий тип не пропустит. */
export const catalogs: Record<string, Catalog> = { ru, en }

type Logical<T> = Base<keyof T & string>

/** Ключи раздела, которых нет во втором каталоге. */
type Diff<A, B> = Exclude<Logical<A>, Logical<B>>

type MissingSectionsInEnglish = Exclude<keyof typeof ru, keyof typeof en>
type MissingSectionsInRussian = Exclude<keyof typeof en, keyof typeof ru>

type MissingInEnglish = {
  [S in keyof typeof ru]: S extends keyof typeof en
    ? `${S & string}.${Diff<(typeof ru)[S], (typeof en)[S]> & string}`
    : never
}[keyof typeof ru]

type MissingInRussian = {
  [S in keyof typeof en]: S extends keyof typeof ru
    ? `${S & string}.${Diff<(typeof en)[S], (typeof ru)[S]> & string}`
    : never
}[keyof typeof en]

/**
 * Утверждение «список пуст» — через `never`, а не через пустой массив.
 *
 * Первая версия объявляла `const missing: Missing[] = []`, и это не проверяло
 * ничего: пустой массив присваивается массиву любого типа, поэтому потерянный
 * ключ проходил зелёным. Ловушку показала мутация — четыре правки каталога, все
 * четыре пережиты. Теперь тип схлопывается к `true` только когда терять нечего,
 * а иначе ошибка прямо называет ключ.
 */
type Assert<T> = [T] extends [never] ? true : T

/**
 * Второй провал той же мутации: полнота **форм**.
 *
 * Логические ключи могут совпадать, а форм не хватать — убери из английского
 * `agents_one`, и `agents_other` останется, ключ `popup.agents` уцелеет, а
 * интерфейс скажет «1 agents». Поэтому у каждой группы проверяется её
 * собственный набор форм: у русского `one/few/many`, у английского `one/other`.
 * Списки разные не по недосмотру — это грамматика языков, и подгонять один под
 * другой нельзя.
 */
type PluralBases<T> = {
  [K in keyof T & string]: K extends `${infer Head}_${PluralSuffix}` ? Head : never
}[keyof T & string]

type MissingForms<T, Forms extends string> = {
  [Base in PluralBases<T> & string]: {
    [Form in Forms]: `${Base}_${Form}` extends keyof T ? never : `${Base}_${Form}`
  }[Forms]
}[PluralBases<T> & string]

type MissingRussianForms = {
  [S in keyof typeof ru]: MissingForms<(typeof ru)[S], 'one' | 'few' | 'many'>
}[keyof typeof ru]

type MissingEnglishForms = {
  [S in keyof typeof en]: MissingForms<(typeof en)[S], 'one' | 'other'>
}[keyof typeof en]

export const missingRussianForms: Assert<MissingRussianForms> = true
export const missingEnglishForms: Assert<MissingEnglishForms> = true

export const missingSectionsInEnglish: Assert<MissingSectionsInEnglish> = true
export const missingSectionsInRussian: Assert<MissingSectionsInRussian> = true
export const missingInEnglish: Assert<MissingInEnglish> = true
export const missingInRussian: Assert<MissingInRussian> = true
