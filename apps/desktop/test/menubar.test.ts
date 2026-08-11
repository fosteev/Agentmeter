import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  barBinaryPath,
  decodeEvent,
  encodeIcon,
  encodeMenu,
  splitLines,
  startNativeBar,
} from '../src/main/menubar.ts'

/**
 * Мост к нативному значку в menu bar.
 *
 * Проверяется протокол и поведение при поломках, а не AppKit: встал ли пункт в
 * панель, видно только на живой macOS, и это делает проверка 10 в
 * `package-smoke.ts`. Здесь ловится то, что ошибается молча — разорванная
 * строка в трубе, рамка неразмещённого пункта, мёртвый хелпер.
 */

/** Поддельный `spawn`: та же форма, что у настоящего, но без процесса. */
function fakeSpawn(): {
  spawnFn: () => unknown
  child: EventEmitter & { stdout: PassThrough; stdin: PassThrough }
  written: string[]
} {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => true,
  })
  const written: string[] = []
  child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))
  return { spawnFn: () => child, child, written }
}

describe('нативный значок в menu bar', () => {
  /**
   * Ловит сборку строк по кускам. Труба отдаёт байты как придётся, и событие
   * клика приезжает разорванным ровно тогда, когда кликают часто: без склейки
   * попап открывался бы через раз, а выглядело бы это «иногда не срабатывает».
   */
  it('строка, разорванная между кусками, собирается целиком', () => {
    const first = splitLines('', '{"t":"click","fra')
    expect(first.lines).toEqual([])

    const second = splitLines(first.rest, 'me":{"x":1,"y":2,"width":3,"height":4}}\n{"t":"ready"')
    expect(second.lines).toHaveLength(1)
    expect(decodeEvent(second.lines[0]!)).toEqual({
      type: 'click',
      frame: { x: 1, y: 2, width: 3, height: 4 },
    })
    // Хвост без перевода строки наружу не выдаётся: это ещё не событие.
    expect(second.rest).toBe('{"t":"ready"')
  })

  /**
   * Ловит доверие к трубе. В stdout чужого процесса попадает что угодно —
   * предупреждение линкера, отладочная строка, — и падение приложения из-за
   * такой строки означало бы, что значок роняет весь продукт.
   */
  it('чужая и битая строка отбрасывается, а не роняет', () => {
    expect(decodeEvent('ld: warning: no platform load command')).toBeUndefined()
    expect(decodeEvent('{"t":"unknown"}')).toBeUndefined()
    expect(decodeEvent('{"t":"menu"}')).toBeUndefined()
    expect(decodeEvent('null')).toBeUndefined()
    expect(decodeEvent('{"t":"menu","id":"quit"}')).toEqual({ type: 'menu', id: 'quit' })
  })

  /**
   * Ловит рамку неразмещённого пункта. До первой картинки кнопка нулевой
   * высоты, и система ставит её за экраном: отдать такую рамку попапу — открыть
   * его в углу экрана вместо панели, то есть показать «отвалившееся окно».
   */
  it('рамка нулевого размера не считается рамкой', () => {
    expect(decodeEvent('{"t":"ready","frame":{"x":0,"y":1117,"width":16,"height":0}}')).toBeUndefined()
    expect(decodeEvent('{"t":"frame","frame":{"x":1147,"y":4,"width":34,"height":24}}')).toEqual({
      type: 'frame',
      frame: { x: 1147, y: 4, width: 34, height: 24 },
    })
  })

  /**
   * Ловит разъехавшийся протокол: у разделителя нет `id`, и хелпер отличает
   * его именно по этому. Пункт, у которого забыли подпись, показал бы `id`
   * вместо слова — по-английски и мимо каталога.
   */
  it('меню едет с разделителем и подписями', () => {
    const line = encodeMenu([{ id: 'export', label: 'Выгрузить' }, {}, { id: 'quit' }])
    expect(JSON.parse(line)).toEqual({
      t: 'menu',
      items: [{ id: 'export', title: 'Выгрузить' }, {}, { id: 'quit', title: 'quit' }],
    })
    expect(line.endsWith('\n')).toBe(true)

    const icon = JSON.parse(encodeIcon(Buffer.from([1, 2, 3]), 16, 'подсказка'))
    expect(icon).toMatchObject({ t: 'icon', points: 16, template: true, tooltip: 'подсказка' })
    expect(Buffer.from(icon.png, 'base64')).toEqual(Buffer.from([1, 2, 3]))
  })

  /**
   * Ловит путь к бинарнику. В упаковке он лежит в ресурсах, в разработке — в
   * выводе сборки, и перепутанные ветки дают приложение без значка: ошибка
   * видна только у установленного.
   */
  it('бинарник ищется в ресурсах у собранного и в сборке у исходников', () => {
    // Склейка своя у каждой системы: путь собирается `join`, и сверять его
    // зашитой косой значит проверять платформу, а не выбор ветки.
    expect(barBinaryPath(true, '/A/Contents/Resources', '/repo')).toBe(
      join('/A/Contents/Resources', 'agentmeter-menubar'),
    )
    expect(barBinaryPath(false, '/A/Contents/Resources', '/repo')).toBe(
      join('/repo', 'menubar', 'build', 'agentmeter-menubar'),
    )
  })

  /**
   * Ловит молчаливое отсутствие значка. Нет бинарника — вызывающий обязан
   * узнать об этом и поднять `Tray`; `undefined` здесь и есть тот сигнал.
   */
  it('без бинарника значок не заводится', () => {
    expect(
      startNativeBar({
        binary: '/нет/такого',
        onClick: () => {},
        onMenu: () => {},
        onExit: () => {},
        exists: () => false,
      }),
    ).toBeUndefined()
  })

  /**
   * Ловит оба конца протокола разом: клик доезжает до попапа, выбор в меню — до
   * действия, рамка запоминается для якоря.
   */
  it('клик, меню и рамка доезжают до приложения', () => {
    const fake = fakeSpawn()
    const clicks: unknown[] = []
    const menu: string[] = []
    const handle = startNativeBar({
      binary: '/есть',
      onClick: (frame) => clicks.push(frame),
      onMenu: (id) => menu.push(id),
      onExit: () => {},
      exists: () => true,
      spawnFn: fake.spawnFn as never,
    })!

    expect(handle.frame()).toBeUndefined()
    fake.child.stdout.write('{"t":"frame","frame":{"x":1147,"y":4,"width":34,"height":24}}\n')
    fake.child.stdout.write('{"t":"click","frame":{"x":1147,"y":4,"width":34,"height":24}}\n')
    fake.child.stdout.write('{"t":"menu","id":"export"}\n')

    expect(handle.frame()).toEqual({ x: 1147, y: 4, width: 34, height: 24 })
    expect(clicks).toHaveLength(1)
    expect(menu).toEqual(['export'])
  })

  /**
   * Ловит порядок в `destroy`. Команда «уходи» обязана уйти **до** того, как
   * мост замолчит: снятый раньше времени флаг глушит собственную команду, и
   * значок остаётся в панели, пережив приложение.
   */
  it('на выходе хелперу успевает уйти команда', () => {
    const fake = fakeSpawn()
    const handle = startNativeBar({
      binary: '/есть',
      onClick: () => {},
      onMenu: () => {},
      onExit: () => {},
      exists: () => true,
      spawnFn: fake.spawnFn as never,
    })!

    handle.destroy()
    expect(fake.written.join('')).toContain('"quit"')
  })

  /**
   * Ловит писание в мёртвую трубу. Хелпер мог упасть сам, и `write` после
   * этого — `EPIPE` в главном процессе, то есть падение приложения из-за
   * значка: ровно наоборот тому, ради чего он заведён.
   */
  it('после смерти хелпера мост молчит, а приложение узнаёт', () => {
    const fake = fakeSpawn()
    let exits = 0
    const handle = startNativeBar({
      binary: '/есть',
      onClick: () => {},
      onMenu: () => {},
      onExit: () => (exits += 1),
      exists: () => true,
      spawnFn: fake.spawnFn as never,
    })!

    fake.child.emit('exit', 1)
    expect(exits).toBe(1)

    const before = fake.written.length
    handle.setIcon(Buffer.from([1]), 16, 'подсказка')
    handle.setMenu([{ id: 'quit', label: 'Выход' }])
    expect(fake.written).toHaveLength(before)
  })
})
