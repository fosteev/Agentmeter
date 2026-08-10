import { describe, expect, it } from 'vitest'
import {
  applyAuto,
  initialUpdateState,
  mayCheck,
  nextUpdateState,
  type UpdateState,
} from '../src/main/update.ts'

/**
 * Автообновление (5.4).
 *
 * Проверяются правила, а не `electron-updater`: его поведение видно только на
 * настоящем релизе, а вот решения «идти ли в сеть» и «что показать» ошибаются
 * тихо. Каждая проверка названа по своей поломке.
 */

const packaged = (auto = true): UpdateState => initialUpdateState('0.1.0', true, auto)

describe('автообновление', () => {
  /**
   * Ловит тумблер без поведения. Проверка обновлений — единственный сетевой
   * вызов продукта, и «выключено» обязано означать «в сеть не ходим», а не
   * «ходим, но молчим».
   */
  it('выключенная настройка запрещает автоматическую проверку, но не ручную', () => {
    const off = packaged(false)

    expect(off.phase).toBe('off')
    expect(mayCheck(off, false)).toBe(false)
    // Ручная работает и на выключенной: иначе тумблер означал бы «обновлений
    // больше не будет никогда», а он про автоматику.
    expect(mayCheck(off, false, true)).toBe(true)
    expect(mayCheck(packaged(), true)).toBe(true)
  })

  /**
   * Ловит проверку по таймеру, стирающую скачанное. Раз в шесть часов приходит
   * очередная, и без правила «`ready` не отменяется ничем, кроме установки»
   * кнопка «Установить и перезапустить» исчезала бы у человека из-под курсора,
   * а приложение выглядело бы исправным.
   */
  it('скачанное обновление переживает и проверку, и ошибку сети', () => {
    let state = nextUpdateState(packaged(), { type: 'found', version: '0.2.0' })
    state = nextUpdateState(state, { type: 'ready', version: '0.2.0' })
    expect(state.phase).toBe('ready')

    expect(nextUpdateState(state, { type: 'check' }).phase).toBe('ready')
    expect(nextUpdateState(state, { type: 'error', message: 'нет сети' }).phase).toBe('ready')
    expect(nextUpdateState(state, { type: 'none' }).phase).toBe('ready')
    // И второй проверки в сеть тоже не будет: скачивать уже нечего.
    expect(mayCheck(state, true, true)).toBe(false)
  })

  /**
   * Ловит попытку обновиться из неустановленного приложения: `electron-updater`
   * там не работает вовсе, а кнопка выглядела бы рабочей.
   */
  it('в неустановленном приложении обновлений нет ни автоматических, ни ручных', () => {
    const dev = initialUpdateState('0.1.0', false, true)

    expect(dev.phase).toBe('unsupported')
    expect(mayCheck(dev, true)).toBe(false)
    expect(mayCheck(dev, true, true)).toBe(false)
    // Событие извне тоже не выводит из этой фазы — приходить ему неоткуда.
    expect(nextUpdateState(dev, { type: 'ready', version: '9.9.9' }).phase).toBe('unsupported')
    expect(applyAuto(dev, true).phase).toBe('unsupported')
  })

  /** Ловит процент, приехавший дробным или за краем: он идёт прямо в подпись. */
  it('процент скачанного округляется и не вылезает за края', () => {
    const state = nextUpdateState(packaged(), { type: 'found', version: '0.2.0' })

    expect(nextUpdateState(state, { type: 'progress', percent: 12.7 }).percent).toBe(13)
    expect(nextUpdateState(state, { type: 'progress', percent: -5 }).percent).toBe(0)
    expect(nextUpdateState(state, { type: 'progress', percent: 140 }).percent).toBe(100)
    // Найденная версия при этом не теряется: она стоит в подписи рядом.
    expect(nextUpdateState(state, { type: 'progress', percent: 40 }).version).toBe('0.2.0')
  })

  /**
   * Ловит настройку, применяющуюся со следующего запуска. Выключил — замолчало
   * сейчас; включил — вернулось в покой, а не в старую фазу.
   */
  it('переключение настройки меняет состояние немедленно', () => {
    const checking = nextUpdateState(packaged(), { type: 'check' })

    const off = applyAuto(checking, false)
    expect(off.phase).toBe('off')
    expect(mayCheck(off, false)).toBe(false)

    expect(applyAuto(off, true).phase).toBe('idle')
    // Скачанное обновление переживает и это: файл уже на диске.
    const ready = nextUpdateState(packaged(), { type: 'ready', version: '0.2.0' })
    expect(applyAuto(ready, true).phase).toBe('ready')
  })
})
