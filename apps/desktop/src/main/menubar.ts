/**
 * Мост к нативному значку в menu bar (macOS).
 *
 * **Зачем он вообще.** На macOS 26 `Tray` из Electron 43 в панель не встаёт:
 * система паркует пункт за нижней кромкой экрана. Замерено с трёх сторон —
 * `tray.getBounds()` отдаёт `y`, равный высоте экрана; Accessibility показывает
 * ту же координату у процесса; и там же лежат пункты всех Electron-приложений
 * на машине, тогда как нативные соседи стоят на панели. Картинка ни при чём:
 * пункт вообще без картинки уезжает туда же. Поэтому на macOS значок рисует
 * отдельный процесс на Swift (`menubar/AgentmeterBar.swift`), а на Windows и
 * Linux остаётся `Tray` — там он работает, и второй механизм ради единообразия
 * означал бы вторую поломку.
 *
 * **Что здесь есть и чего нет.** Здесь протокол и правила: как собрать строку,
 * как разобрать ответ, где лежит бинарник, что делать, если он не запустился.
 * Рисование иконки не переехало — растр по-прежнему считает `tray-icon.ts`,
 * сверенный с макетом юнит-тестами, а сюда приезжает готовый PNG. Иначе
 * геометрия значка жила бы в двух местах на двух языках.
 *
 * Мост не знает про Electron намеренно: всё, что он принимает, — буфер PNG и
 * строки. Так правила проверяются обычным тестом, без запуска приложения, —
 * тем же способом, что и состояние обновлений в `update.ts`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Рамка пункта в координатах Electron: начало сверху слева, `y` вниз. */
export interface BarFrame {
  x: number
  y: number
  width: number
  height: number
}

export type BarEvent =
  | { type: 'ready'; frame: BarFrame }
  /**
   * Пункт переразмещён — приезжает после каждой иконки. До первой картинки
   * кнопка нулевой высоты, система пункт не ставит, и рамка на старте пустая:
   * якорь попапа берётся отсюда, а не из `ready`.
   */
  | { type: 'frame'; frame: BarFrame }
  | { type: 'click'; frame: BarFrame }
  | { type: 'menu'; id: string }

/** Пункт меню по правой кнопке. Без `id` — разделитель. */
export interface BarMenuEntry {
  id?: string
  label?: string
}

/**
 * Сборка строк из потока.
 *
 * Труба отдаёт байты кусками, и кусок не обязан кончаться на границе строки:
 * событие клика приезжает разорванным ровно тогда, когда кликают часто. Поэтому
 * хвост возвращается наружу и приклеивается к следующему куску.
 */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (rest + chunk).split('\n')
  const tail = parts.pop() ?? ''
  return { lines: parts.filter((line) => line.trim() !== ''), rest: tail }
}

/**
 * Разбор события хелпера.
 *
 * Незнакомое и битое молча отбрасывается: в трубе может оказаться чужая строка
 * (предупреждение линкера, отладочный вывод), и падать из-за неё приложению
 * незачем — значок важнее строгости.
 */
export function decodeEvent(line: string): BarEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const message = parsed as Record<string, unknown>
  if (message['t'] === 'menu') {
    return typeof message['id'] === 'string' ? { type: 'menu', id: message['id'] } : undefined
  }
  const type = message['t']
  if (type !== 'ready' && type !== 'click' && type !== 'frame') return undefined
  const frame = asFrame(message['frame'])
  if (frame === undefined) return undefined
  return { type, frame }
}

function asFrame(value: unknown): BarFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const numbers = ['x', 'y', 'width', 'height'].map((key) => raw[key])
  if (!numbers.every((one) => typeof one === 'number' && Number.isFinite(one))) return undefined
  const [x, y, width, height] = numbers as number[]
  // Нулевая ширина — пункт, которого система ещё не разместила. Такую рамку
  // нельзя отдавать попапу: он прижмётся к левому верхнему углу экрана и будет
  // выглядеть отвалившимся окном.
  if (width! <= 0 || height! <= 0) return undefined
  return { x: x!, y: y!, width: width!, height: height! }
}

/** Команда «вот иконка»: PNG под ретину плюс размер в точках. */
export function encodeIcon(png: Buffer, points: number, tooltip: string): string {
  return (
    JSON.stringify({
      t: 'icon',
      png: png.toString('base64'),
      points,
      template: true,
      tooltip,
    }) + '\n'
  )
}

/** Команда «вот меню по правой кнопке». */
export function encodeMenu(items: readonly BarMenuEntry[]): string {
  return (
    JSON.stringify({
      t: 'menu',
      items: items.map((item) =>
        item.id === undefined ? {} : { id: item.id, title: item.label ?? item.id },
      ),
    }) + '\n'
  )
}

/**
 * Где лежит бинарник.
 *
 * В собранном приложении — рядом с ресурсами (`extraResources` кладёт его в
 * `Contents/Resources`), в разработке — вывод `scripts/build-menubar.js`.
 * Обе ветки проверяются существованием файла, а не платформой: собранный
 * бинарник могли не положить в упаковку, и это ровно та поломка, которую видно
 * только у установленного приложения.
 */
export function barBinaryPath(packaged: boolean, resourcesPath: string, repoRoot: string): string {
  return packaged
    ? join(resourcesPath, 'agentmeter-menubar')
    : join(repoRoot, 'menubar', 'build', 'agentmeter-menubar')
}

export interface NativeBar {
  /** Показать иконку. `png` — растр под ретину, `points` — его размер в точках. */
  setIcon: (png: Buffer, points: number, tooltip: string) => void
  setMenu: (items: readonly BarMenuEntry[]) => void
  /** Последняя известная рамка пункта. `undefined` — пункт ещё не размещён. */
  frame: () => BarFrame | undefined
  destroy: () => void
}

export interface NativeBarOptions {
  binary: string
  onClick: (frame: BarFrame) => void
  onMenu: (id: string) => void
  /** Хелпер умер сам. Приложение обязано узнать: значка больше нет. */
  onExit: (code: number | null) => void
  spawnFn?: typeof spawn
  exists?: (path: string) => boolean
}

/**
 * Запустить хелпер.
 *
 * `undefined` означает «нативного значка не будет» — бинарника нет или он не
 * стартовал. Вызывающий обязан на это ответить обычным `Tray`: молчаливое
 * отсутствие значка — ровно та поломка, из-за которой всё это написано.
 */
export function startNativeBar(options: NativeBarOptions): NativeBar | undefined {
  const exists = options.exists ?? existsSync
  if (!exists(options.binary)) return undefined

  let child: ChildProcessWithoutNullStreams
  try {
    child = (options.spawnFn ?? spawn)(options.binary, [], { stdio: 'pipe' })
  } catch {
    return undefined
  }

  let last: BarFrame | undefined
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const split = splitLines(rest, chunk)
    rest = split.rest
    for (const line of split.lines) {
      const event = decodeEvent(line)
      if (event === undefined) continue
      if (event.type === 'menu') {
        options.onMenu(event.id)
        continue
      }
      last = event.frame
      if (event.type === 'click') options.onClick(event.frame)
    }
  })
  // Труба закрывается, когда хелпер уходит: писать в неё после этого — `EPIPE`
  // в главном процессе, то есть падение приложения из-за значка.
  let alive = true
  const send = (line: string): void => {
    if (!alive || child.stdin.destroyed) return
    child.stdin.write(line)
  }
  child.on('exit', (code) => {
    alive = false
    options.onExit(code)
  })
  child.on('error', () => {
    alive = false
  })

  return {
    setIcon: (png, points, tooltip) => send(encodeIcon(png, points, tooltip)),
    setMenu: (items) => send(encodeMenu(items)),
    frame: () => last,
    destroy: () => {
      if (!alive) return
      // Сначала «уходи», потом флаг: снятый раньше времени флаг глушит
      // собственную команду, и хелпер остаётся жить со значком в панели.
      send(JSON.stringify({ t: 'quit' }) + '\n')
      alive = false
      child.kill()
    },
  }
}
