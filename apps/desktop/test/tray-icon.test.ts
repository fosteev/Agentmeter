import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Provider } from '@agentmeter/core'
import { PALETTE, levelFor, trayBitmap, type TrayState } from '../src/main/tray-icon.ts'

/**
 * Иконка трея (2.7). Проверяется растр, а не картинка глазами: единственное,
 * что иконка обязана сообщать, — число работающих агентов и уровень тревоги, и
 * оба факта читаются из пикселей.
 *
 * Каждая проверка названа по поломке, которую ловит.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const design = readFileSync(`${root}design/Agentmeter.dc.html`, 'utf8')

const SIZE = 32

function state(patch: Partial<TrayState> = {}): TrayState {
  return { agents: [], warnAt: 75, dangerAt: 90, ...patch }
}

interface Pixel {
  b: number
  g: number
  r: number
  a: number
}

function pixel(bitmap: { data: Buffer; width: number }, x: number, y: number): Pixel {
  const at = (y * bitmap.width + x) * 4
  return {
    b: bitmap.data[at]!,
    g: bitmap.data[at + 1]!,
    r: bitmap.data[at + 2]!,
    a: bitmap.data[at + 3]!,
  }
}

/** Высота непрозрачного столбца в пикселях — по одной колонке растра. */
function columnHeight(bitmap: { data: Buffer; width: number; height: number }, x: number): number {
  let count = 0
  for (let y = 0; y < bitmap.height; y += 1) if (pixel(bitmap, x, y).a > 0) count += 1
  return count
}

/** Непрозрачные колонки, сгруппированные в подряд идущие полосы. */
function columns(bitmap: {
  data: Buffer
  width: number
  height: number
}): Array<{ from: number; to: number; height: number }> {
  const out: Array<{ from: number; to: number; height: number }> = []
  let run: { from: number; to: number; height: number } | undefined
  for (let x = 0; x < bitmap.width; x += 1) {
    const height = columnHeight(bitmap, x)
    if (height === 0) {
      if (run) out.push(run)
      run = undefined
      continue
    }
    if (run === undefined) run = { from: x, to: x, height }
    else {
      run.to = x
      run.height = Math.max(run.height, height)
    }
  }
  if (run) out.push(run)
  return out
}

/** oklch → sRGB. Тот же перевод, который однажды сделан руками в `PALETTE`. */
function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  return linear.map((value) => {
    const encoded =
      value <= 0.0031308 ? 12.92 * value : 1.055 * Math.max(value, 0) ** (1 / 2.4) - 0.055
    return Math.max(0, Math.min(255, Math.round(encoded * 255)))
  }) as [number, number, number]
}

function designColor(name: string): [number, number, number] {
  const match = design.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`))
  if (!match) throw new Error(`в макете нет токена --${name}`)
  return oklchToRgb(Number(match[1]), Number(match[2]), Number(match[3]))
}

describe('иконка трея', () => {
  /**
   * Ловит палитру, уехавшую от макета. Буфер иконки — не CSS, `var(--claude)`
   * в него не положишь, поэтому цвета записаны числами; числа, записанные
   * руками, расходятся с источником молча и навсегда.
   */
  it('цвета пересчитываются из :root макета до единицы канала', () => {
    const expected = {
      claude: designColor('claude'),
      codex: designColor('codex'),
      warn: designColor('warn'),
      alarm: designColor('alarm'),
      dim: designColor('tx3'),
      track: designColor('s2'),
    }
    for (const [name, rgb] of Object.entries(expected)) {
      expect([...PALETTE[name as keyof typeof PALETTE]], name).toEqual(rgb)
    }
  })

  /**
   * Ловит единственное измерение иконки, потерянное или обрезанное: «число
   * активных агентов = число поднятых столбиков» (строка 316 макета). Столбиков
   * всегда три, поднятых — столько, сколько агентов.
   */
  it('поднятых столбиков ровно столько, сколько работает агентов', () => {
    const heights = (count: number): number[] => {
      const agents: Provider[] = new Array(count).fill('claude')
      return columns(trayBitmap(state({ agents }), SIZE, false)).map((run) => run.height)
    }
    const floor = heights(0)
    expect(floor.length).toBe(3)
    expect(new Set(floor).size, 'простой: все три столбика одной высоты').toBe(1)

    for (const count of [1, 2, 3]) {
      const bars = heights(count)
      expect(bars.length, `${count}: столбиков всегда три`).toBe(3)
      const raised = bars.filter((height) => height > floor[0]!).length
      expect(raised, `${count}: поднятых столбиков`).toBe(count)
    }
  })

  /**
   * Ловит потерянную оговорку макета (строка 316): агентов бывает больше трёх,
   * а столбиков только три, и «четыре» обязано отличаться от «трёх» — иначе
   * иконка молча врёт про число работающих.
   */
  it('больше трёх агентов — третий столбик двойной ширины', () => {
    const width = (count: number): number => {
      const agents: Provider[] = new Array(count).fill('claude')
      const runs = columns(trayBitmap(state({ agents }), SIZE, false))
      const last = runs.at(-1)!
      return last.to - last.from + 1
    }
    expect(width(4)).toBeGreaterThan(width(3))
  })

  /**
   * Ловит потерянное различие провайдеров — то самое сквозное «янтарный против
   * холодного», которое задано в разделе 0 и дальше не переизобретается.
   */
  it('цвет столбика — цвет своего провайдера', () => {
    const bitmap = trayBitmap(state({ agents: ['claude', 'codex'] }), SIZE, false)
    const runs = columns(bitmap)
    const colorOf = (run: { from: number; to: number }): Pixel => {
      for (let y = 0; y < SIZE; y += 1) {
        const point = pixel(bitmap, run.from, y)
        if (point.a > 0) return point
      }
      throw new Error('пустой столбик')
    }
    const first = colorOf(runs[0]!)
    const second = colorOf(runs[1]!)
    // BGRA, а не RGBA: перепутанные каналы дают синюю иконку вместо янтарной,
    // и проверка «пиксель непрозрачен» этого не замечает.
    expect([first.r, first.g, first.b]).toEqual([...PALETTE.claude])
    expect([second.r, second.g, second.b]).toEqual([...PALETTE.codex])
  })

  /**
   * Ловит тревогу, которую видно только в попапе. Когда лимит на исходе, важно
   * не кто работает, а что работать скоро будет нельзя, — и цвет провайдера
   * обязан уступить.
   */
  it('на исходе и на пределе столбики перекрашены, полоса того же уровня', () => {
    const agents: Provider[] = ['claude']
    const calm = trayBitmap(state({ agents, limitPercent: 40 }), SIZE, false)
    const warn = trayBitmap(state({ agents, limitPercent: 86 }), SIZE, false)
    const alarm = trayBitmap(state({ agents, limitPercent: 100 }), SIZE, false)

    // Цвет читается с самого верхнего непрозрачного пикселя — это макушка
    // высокого столбика. По первой непрозрачной **колонке** читать нельзя:
    // дорожка лимита шире группы столбиков, и колонка слева от них принадлежит
    // ей. Проверка при этом зеленела бы, сверяя цвет полосы сама с собой.
    const litColor = (bitmap: { data: Buffer; width: number; height: number }): number[] => {
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const point = pixel(bitmap, x, y)
          if (point.a > 0) return [point.r, point.g, point.b]
        }
      }
      throw new Error('пустая иконка')
    }
    expect(litColor(calm)).toEqual([...PALETTE.claude])
    expect(litColor(warn)).toEqual([...PALETTE.warn])
    expect(litColor(alarm)).toEqual([...PALETTE.alarm])
    expect(levelFor(state({ limitPercent: 74 }))).toBe('calm')
    expect(levelFor(state({ limitPercent: 75 }))).toBe('warn')
    expect(levelFor(state({ limitPercent: 90 }))).toBe('alarm')
  })

  /**
   * Ловит ровно ту ошибку, ради которой затевался продукт: незнание,
   * показанное нулём. У Claude до калибровки 1.9 процента нет ни у одного
   * окна, и пустая дорожка в иконке читалась бы как «израсходовано нисколько».
   */
  it('без процента полосы нет вовсе, с процентом её длина равна проценту', () => {
    const agents: Provider[] = ['claude']
    const unknown = trayBitmap(state({ agents }), SIZE, false)
    const known = trayBitmap(state({ agents, limitPercent: 86 }), SIZE, false)

    // Дорожка ищется по своему цвету, а не по строке растра: геометрия иконки —
    // дело самой иконки, и проверка, повторяющая её числа, ловит опечатку в
    // своей копии, а не поломку.
    const rowsWith = (
      bitmap: { data: Buffer; width: number },
      color: readonly [number, number, number],
    ): number[] => {
      const rows: number[] = []
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const point = pixel(bitmap, x, y)
          if (point.a > 0 && point.r === color[0] && point.g === color[1] && point.b === color[2]) {
            rows.push(y)
            break
          }
        }
      }
      return rows
    }

    expect(rowsWith(unknown, PALETTE.track), 'без процента дорожки нет').toEqual([])
    const trackRows = rowsWith(known, PALETTE.track)
    expect(trackRows.length).toBeGreaterThan(0)

    // Заливка занимает свою долю дорожки, а не всю её и не константу.
    const row = trackRows[0]!
    let track = 0
    let filled = 0
    for (let x = 0; x < SIZE; x += 1) {
      const point = pixel(known, x, row)
      if (point.a === 0) continue
      if (point.r === PALETTE.track[0] && point.g === PALETTE.track[1]) track += 1
      if (point.r === PALETTE.warn[0] && point.g === PALETTE.warn[1]) filled += 1
    }
    const percent = Math.round((filled / (filled + track)) * 100)
    expect(percent).toBeGreaterThanOrEqual(80)
    expect(percent).toBeLessThan(100)
  })

  /**
   * Ловит цветную иконку в menu bar. Template image определяется одной альфой,
   * система красит его сама; цветной выглядит рабочим и просто не переключается
   * вместе с темой, оказываясь тёмным на тёмной панели.
   */
  it('в монохроме нет ни одного цветного пикселя, а роль цвета берёт альфа', () => {
    const bitmap = trayBitmap(state({ agents: ['claude'], limitPercent: 86 }), SIZE, true)
    const alphas = new Set<number>()
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const point = pixel(bitmap, x, y)
        if (point.a === 0) continue
        expect([point.r, point.g, point.b], `цвет в template на ${x},${y}`).toEqual([0, 0, 0])
        alphas.add(point.a)
      }
    }
    // Горящий столбик, погашенный и дорожка — три разные прозрачности.
    expect(alphas.size).toBeGreaterThanOrEqual(3)
  })

  /**
   * Ловит потерянную инверсию: на пределе монохромная иконка меняет не цвет
   * (его нет), а форму — залитый квадрат с прорезью вместо столбиков
   * (строки 307–313 макета). Без этого «предел» в menu bar неотличим от
   * «на исходе».
   */
  it('на пределе монохром переворачивается в залитый квадрат', () => {
    const warn = trayBitmap(state({ agents: ['claude'], limitPercent: 86 }), SIZE, true)
    const alarm = trayBitmap(state({ agents: ['claude'], limitPercent: 100 }), SIZE, true)
    const ink = (bitmap: { data: Buffer; width: number }): number => {
      let count = 0
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) if (pixel(bitmap, x, y).a > 0) count += 1
      }
      return count
    }
    expect(ink(alarm)).toBeGreaterThan(ink(warn) * 2)
    // Прорезь — дырка в альфе: сквозь неё видно панель, это и есть инверсия.
    expect(pixel(alarm, SIZE / 2, SIZE / 2).a).toBe(0)
  })

  /**
   * Ловит растр, нарисованный целыми пикселями одного размера: на retina
   * иконка берёт представление @2x, и геометрия, сошедшаяся в 16 точек, в 32 и
   * 48 либо слипается, либо разъезжается.
   */
  it('пропорции держатся на всех трёх плотностях', () => {
    for (const size of [16, 32, 48]) {
      const bitmap = trayBitmap(state({ agents: ['claude', 'claude', 'claude'] }), size, false)
      const runs = columns(bitmap)
      expect(runs.length, `${size}: столбиков`).toBe(3)
      // Высоты идут по убыванию — ритм макета 22/16/11.
      expect(runs[0]!.height, `${size}: первый выше второго`).toBeGreaterThan(runs[1]!.height)
      expect(runs[1]!.height, `${size}: второй выше третьего`).toBeGreaterThan(runs[2]!.height)
    }
  })
})
