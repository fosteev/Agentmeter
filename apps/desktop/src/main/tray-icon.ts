/**
 * Иконка в трее (2.7). Раздел 1 макета, строки 209–322.
 *
 * Не ассеты, а рисование в буфер, и это не лень. Ассетами пришлось бы хранить
 * пять состояний × два режима × три плотности экрана = тридцать файлов, а
 * состояний на самом деле больше: у каждого поднятого столбика свой цвет по
 * провайдеру, и «два агента Claude» отличается от «Claude и Codex». Перебирать
 * такое картинками нельзя, а рисовать — двадцать строк.
 *
 * Electron здесь не импортируется намеренно: рисование обязано проверяться без
 * запуска приложения, а `nativeImage` живёт в `index.ts`, где ему и место.
 *
 * **Что в иконке измерение, а что рифма.** Измерение ровно два: число поднятых
 * столбиков равно числу работающих агентов (так и написано в макете, строка
 * 316) и длина полосы равна проценту ближайшего к потолку окна. Высоты 22/16/11
 * — это ритм, а не величина: они постоянные и говорят только «этот столбик
 * первый». Поэтому в тултип уходит текст, а не догадка по картинке.
 *
 * Процента может не быть вовсе — у Claude до калибровки 1.9 его нет ни у
 * одного окна. Тогда полосы нет: пустая полоса читается как «израсходовано
 * нисколько», и это ровно то враньё, ради борьбы с которым написан продукт.
 */
import type { Provider } from '@agentmeter/core'

export type TrayLevel = 'calm' | 'warn' | 'alarm'

export interface TrayState {
  /**
   * Провайдеры работающих агентов, от старшего столбика к младшему. Больше
   * трёх — третий становится двойной ширины (строка 316 макета).
   */
  agents: readonly Provider[]
  /** Ближайший к потолку процент. `undefined` — процента нет, полосы не будет. */
  limitPercent?: number | undefined
  /** Порог предупреждения, `alerts.warnAtPercent`. */
  warnAt: number
  /** Порог тревоги, `alerts.dangerAtPercent`. */
  dangerAt: number
}

export interface Bitmap {
  width: number
  height: number
  /** Сырой BGRA, как ждёт `nativeImage.createFromBitmap`. */
  data: Buffer
}

type Rgb = readonly [number, number, number]

/**
 * Палитра в sRGB — те же токены раздела 0, переведённые из oklch.
 *
 * Перевод сделан один раз и записан числами, а не считается на старте: буфер
 * иконки — не CSS, `var(--claude)` в него не положишь. Чтобы перевод не уехал
 * от макета, `apps/desktop/test/tray-icon.test.ts` пересчитывает эти числа
 * прямо из `:root` макета и сверяет с точностью до единицы канала.
 */
export const PALETTE = {
  claude: [234, 155, 81],
  codex: [65, 192, 205],
  warn: [231, 177, 64],
  alarm: [228, 93, 83],
  /** Погашенный столбик — «слот пустует». */
  dim: [114, 118, 124],
  /** Дорожка полосы лимита. */
  track: [34, 37, 42],
} as const satisfies Record<string, Rgb>

/**
 * Геометрия макета в его же единицах — пикселях тайла 64×64 (строки 216–265).
 *
 * Из тайла берутся **пропорции, а не поля**. В макете содержимое занимает 22
 * единицы высоты из 64, то есть треть: остальное — воздух вокруг образца на
 * листе спецификации. Перенести этот воздух в иконку значит нарисовать
 * шестнадцать точек, из которых работают пять, — в menu bar такое читается как
 * «приложение сломалось». Поэтому содержимое вписывается в бокс иконки целиком,
 * а отношения внутри него остаются макетными.
 */
const BAR_W = 6
const BAR_GAP = 4
const BAR_FLOOR = 6
/** Высоты поднятых столбиков — ритм из макета, не величина. */
const BAR_RAISED = [22, 16, 11] as const
const TRACK_W = 30
const TRACK_H = 4
/** Зазор между группой столбиков и полосой лимита (строка 244). */
const TRACK_GAP = 5
/** Инверсия в монохроме: квадрат с прорезью (строки 308–311). */
const GLYPH = 34
const GLYPH_R = 8
const SLOT_W = 16
const SLOT_H = 4

/** Прозрачность монохрома: погашенный столбик против горящего (строки 274–284). */
const MONO_DIM = 0.45
const MONO_LIT = 0.95

export function levelFor(state: TrayState): TrayLevel {
  const percent = state.limitPercent
  if (percent === undefined) return 'calm'
  if (percent >= state.dangerAt) return 'alarm'
  if (percent >= state.warnAt) return 'warn'
  return 'calm'
}

/**
 * Растр иконки.
 *
 * `template` — режим macOS: там цвета нет вовсе, система красит иконку сама по
 * альфе, поэтому все пиксели чёрные и роль цвета берут высота столбиков и
 * инверсия. Ошибиться тут легко и незаметно: цветная иконка в menu bar
 * выглядит рабочей и просто не переключается вместе с темой.
 */
export function trayBitmap(state: TrayState, size: number, template: boolean): Bitmap {
  const data = Buffer.alloc(size * size * 4)
  const level = levelFor(state)

  if (template && level === 'alarm') {
    drawGlyph(data, size)
    return { width: size, height: size, data }
  }

  const raised = Math.min(state.agents.length, 3)
  const crowded = state.agents.length > 3
  const showTrack = level !== 'calm' && state.limitPercent !== undefined

  const barsWidth = BAR_W * (crowded ? 4 : 3) + BAR_GAP * 2
  const contentW = showTrack ? Math.max(barsWidth, TRACK_W) : barsWidth
  const contentH = showTrack ? BAR_RAISED[0] + TRACK_GAP + TRACK_H : BAR_RAISED[0]
  // Небольшое поле по краям: иконка, упирающаяся в границы бокса, читается как
  // обрезанная, а не как большая.
  const box = size - 2 * Math.max(1, Math.round(size / 16))
  const scale = Math.min(box / contentW, box / contentH)
  /**
   * Единицы макета → целые пиксели, и не меньше одного.
   *
   * Округляется **размер**, а не края прямоугольника. Округляя края по
   * отдельности, получаешь столбики то в один пиксель, то в два в одной иконке:
   * при 16 точках столбик — это полтора пикселя, и куда упадёт полтинник,
   * зависит от того, где столбик стоит. На тайле 64 этого не видно, в трее
   * видно сразу.
   */
  const px = (units: number): number => Math.max(1, Math.round(units * scale))

  const top = Math.round((size - contentH * scale) / 2)
  const baseline = top + px(BAR_RAISED[0])

  const gap = px(BAR_GAP)
  const widths = [0, 1, 2].map((slot) => (crowded && slot === 2 ? px(BAR_W) * 2 : px(BAR_W)))
  let x = Math.round((size - (widths[0]! + widths[1]! + widths[2]! + gap * 2)) / 2)

  for (let slot = 0; slot < 3; slot += 1) {
    const lit = slot < raised
    const height = lit ? px(BAR_RAISED[slot]!) : px(BAR_FLOOR)
    const color = lit ? litColor(state, level, slot) : PALETTE.dim
    const alpha = template ? (lit ? MONO_LIT : MONO_DIM) : 1
    fill(data, size, x, baseline - height, widths[slot]!, height, color, alpha, template)
    x += widths[slot]! + gap
  }

  if (showTrack) {
    const trackW = px(TRACK_W)
    const trackH = px(TRACK_H)
    const trackX = Math.round((size - trackW) / 2)
    const trackY = baseline + px(TRACK_GAP)
    const done = Math.min(100, Math.max(0, state.limitPercent!)) / 100
    fill(data, size, trackX, trackY, trackW, trackH, PALETTE.track, template ? 0.3 : 1, template)
    fill(
      data,
      size,
      trackX,
      trackY,
      Math.round(trackW * done),
      trackH,
      level === 'alarm' ? PALETTE.alarm : PALETTE.warn,
      template ? MONO_LIT : 1,
      template,
    )
  }

  return { width: size, height: size, data }
}

/**
 * Цвет горящего столбика.
 *
 * Тревога перекрашивает все столбики (карточки 4 и 5 макета): когда лимит на
 * исходе, важно не кто работает, а что работать скоро будет нельзя. Пока
 * тревоги нет — цвет провайдера, тот же янтарный против холодного, что везде.
 */
function litColor(state: TrayState, level: TrayLevel, slot: number): Rgb {
  if (level === 'alarm') return PALETTE.alarm
  if (level === 'warn') return PALETTE.warn
  return state.agents[slot] === 'codex' ? PALETTE.codex : PALETTE.claude
}

/** Инверсия монохрома: залитый квадрат со скруглением и прорезью внутри. */
function drawGlyph(data: Buffer, size: number): void {
  const side = size - 2 * Math.max(1, Math.round(size / 16))
  const scale = side / GLYPH
  const px = (units: number): number => Math.max(1, Math.round(units * scale))
  const radius = px(GLYPH_R)
  const left = Math.round((size - side) / 2)
  const top = Math.round((size - side) / 2)
  for (let y = top; y < top + side; y += 1) {
    for (let x = left; x < left + side; x += 1) {
      if (!insideRounded(x + 0.5, y + 0.5, left, top, side, radius)) continue
      put(data, size, x, y, PALETTE.dim, MONO_LIT, true)
    }
  }
  // Прорезь — дырка в альфе, а не тёмный пиксель: в template image цвета нет,
  // и «тёмный» здесь означает «прозрачный», сквозь который видно menu bar.
  const slotW = px(SLOT_W)
  const slotH = px(SLOT_H)
  clear(data, size, Math.round((size - slotW) / 2), Math.round((size - slotH) / 2), slotW, slotH)
}

function insideRounded(
  x: number,
  y: number,
  left: number,
  top: number,
  side: number,
  radius: number,
): boolean {
  const right = left + side
  const bottom = top + side
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 + 1e-9
}

function fill(
  data: Buffer,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgb,
  alpha: number,
  template: boolean,
): void {
  for (let py = y; py < y + height; py += 1) {
    for (let pxi = x; pxi < x + width; pxi += 1) put(data, size, pxi, py, color, alpha, template)
  }
}

function clear(
  data: Buffer,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  for (let py = y; py < y + height; py += 1) {
    for (let pxi = x; pxi < x + width; pxi += 1) {
      if (pxi < 0 || py < 0 || pxi >= size || py >= size) continue
      data.fill(0, (py * size + pxi) * 4, (py * size + pxi) * 4 + 4)
    }
  }
}

function put(
  data: Buffer,
  size: number,
  x: number,
  y: number,
  color: Rgb,
  alpha: number,
  template: boolean,
): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return
  const at = (y * size + x) * 4
  // BGRA — порядок каналов сырого битмапа Electron. Перепутанные B и R дают
  // синюю иконку вместо янтарной, и юнит-тест на «пиксель непрозрачен» этого
  // не заметит.
  data[at] = template ? 0 : color[2]
  data[at + 1] = template ? 0 : color[1]
  data[at + 2] = template ? 0 : color[0]
  data[at + 3] = Math.round(alpha * 255)
}
