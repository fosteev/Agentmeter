/**
 * Иконка приложения (5.1).
 *
 *     node --experimental-strip-types scripts/make-icon.ts          # нарисовать
 *     node --experimental-strip-types scripts/make-icon.ts --check  # сверить
 *
 * Рисуется, а не лежит ассетом, по той же причине, что иконка трея (2.7):
 * ассету неоткуда знать про макет, и цвет в нём разъезжается с `:root` молча.
 * Здесь токены **читаются из макета** прямо в момент отрисовки, поэтому
 * разъехаться им негде: правка `--claude` в `design/Agentmeter.dc.html` делает
 * `--check` красным, а не оставляет иконку прошлогодней.
 *
 * Файл один — `apps/desktop/packaging/icon.png`, 1024×1024. Больше не нужно:
 * electron-builder делает из него и `.icns`, и `.ico`, и набор для Linux.
 * Держать три формата в репозитории значило бы держать три копии одного
 * решения, две из которых обновляют руками.
 *
 * Композиция — то же, что показывает трей, когда работают три агента: столбики
 * ритма 22/16/11 из раздела 1 макета. Показания в иконке нет ни одного, и это
 * решение: полоса лимита, застывшая на каком-то проценте, читается как
 * измерение, которого никто не делал.
 */
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const designPath = `${root}design/Agentmeter.dc.html`
const iconPath = `${root}apps/desktop/packaging/icon.png`

const SIZE = 1024
/**
 * Поле вокруг скруглённого квадрата и радиус его углов — пропорции macOS
 * (824 точки содержимого из 1024 и радиус 22.37% от стороны). Windows и Linux
 * рисуют то же изображение как есть, и поле им не мешает: оно читается как
 * воздух, а не как обрезка.
 */
const PAD = Math.round((SIZE * (1024 - 824)) / 2 / 1024)
const BOX = SIZE - 2 * PAD
const RADIUS = Math.round(BOX * 0.2237)

/** Единицы макета (строки 216–265): ширина столбика, зазор, ритм высот. */
const BAR_W = 6
const BAR_GAP = 4
const BAR_RAISED = [22, 16, 11] as const

type Rgb = readonly [number, number, number]

const design = readFileSync(designPath, 'utf8')

/**
 * oklch → sRGB.
 *
 * Второй экземпляр этого перевода в проекте — первый живёт в
 * `apps/desktop/test/tray-icon.test.ts` и проверяет им палитру трея, сделанную
 * руками. Копия здесь намеренная: сведи их в одну, и проверка палитры станет
 * проверять сама себя.
 */
function oklchToRgb(l: number, c: number, h: number): Rgb {
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
  }) as unknown as Rgb
}

function token(name: string): Rgb {
  const match = design.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`))
  if (!match) throw new Error(`в макете нет токена --${name}`)
  return oklchToRgb(Number(match[1]), Number(match[2]), Number(match[3]))
}

/**
 * Растр иконки, RGBA.
 *
 * Сглаживания нет нигде, кроме углов подложки: прямые края столбиков при 1024
 * точках и так лягут в пиксель, а вот скругление без сглаживания видно даже в
 * доке. Считается оно долей площади пикселя внутри окружности — по четырём
 * подточкам, чего для радиуса в 188 точек хватает с запасом.
 */
export function iconBitmap(): Buffer {
  const data = Buffer.alloc(SIZE * SIZE * 4)
  const plate = token('s1')
  const line = token('line')
  const bars: Rgb[] = [token('claude'), token('codex'), token('tx3')]

  // Подложка: скруглённый квадрат с волосяной рамкой в цвет `--line`. Рамка не
  // украшение: на тёмном фоне дока пластина без края сливается с ним, и от
  // иконки остаются три висящих в пустоте столбика.
  const border = Math.max(1, Math.round(SIZE / 256))
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const outer = roundedCoverage(x, y, PAD, PAD, BOX, BOX, RADIUS)
      if (outer === 0) continue
      const inner = roundedCoverage(
        x,
        y,
        PAD + border,
        PAD + border,
        BOX - 2 * border,
        BOX - 2 * border,
        RADIUS - border,
      )
      const color = mix(line, plate, inner)
      put(data, x, y, color, outer)
    }
  }

  // Столбики. Пропорции макетные, поле внутри пластины — четверть её стороны,
  // чтобы столбики не упирались в скругление.
  const contentW = BAR_W * 3 + BAR_GAP * 2
  const contentH = BAR_RAISED[0]
  const inset = Math.round(BOX * 0.22)
  const scale = Math.min((BOX - 2 * inset) / contentW, (BOX - 2 * inset) / contentH)
  const px = (units: number): number => Math.max(1, Math.round(units * scale))
  const barW = px(BAR_W)
  const gap = px(BAR_GAP)
  const baseline = PAD + Math.round((BOX + contentH * scale) / 2)
  let x = PAD + Math.round((BOX - (barW * 3 + gap * 2)) / 2)
  const round = Math.round(barW / 3)
  for (let slot = 0; slot < 3; slot += 1) {
    const height = px(BAR_RAISED[slot]!)
    fillRounded(data, x, baseline - height, barW, height, round, bars[slot]!)
    x += barW + gap
  }
  return data
}

/** Доля пикселя внутри прямоугольника со скруглёнными углами, 0…1. */
function roundedCoverage(
  x: number,
  y: number,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
): number {
  let hits = 0
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      if (insideRounded(x + dx, y + dy, left, top, width, height, radius)) hits += 1
    }
  }
  return hits / 4
}

function insideRounded(
  x: number,
  y: number,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
): boolean {
  if (x < left || y < top || x > left + width || y > top + height) return false
  const cx = Math.min(Math.max(x, left + radius), left + width - radius)
  const cy = Math.min(Math.max(y, top + radius), top + height - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function fillRounded(
  data: Buffer,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
  color: Rgb,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const coverage = roundedCoverage(x, y, left, top, width, height, radius)
      if (coverage > 0) put(data, x, y, color, coverage)
    }
  }
}

/** Наложение цвета с прозрачностью поверх того, что уже лежит в пикселе. */
function put(data: Buffer, x: number, y: number, color: Rgb, alpha: number): void {
  const at = (y * SIZE + x) * 4
  const was = data[at + 3]! / 255
  const now = alpha + was * (1 - alpha)
  if (now === 0) return
  for (let channel = 0; channel < 3; channel += 1) {
    const under = data[at + channel]!
    data[at + channel] = Math.round((color[channel]! * alpha + under * was * (1 - alpha)) / now)
  }
  data[at + 3] = Math.round(now * 255)
}

function mix(from: Rgb, to: Rgb, part: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(from[i]! + (to[i]! - from[i]!) * part)) as unknown as Rgb
}

/**
 * PNG без внешних зависимостей: IHDR, IDAT, IEND.
 *
 * Кодировщик тут короче, чем разговор про выбор библиотеки: строка фильтра
 * нулевая, сжатие — `node:zlib`. Заодно результат побайтно воспроизводим, и
 * `--check` может сравнивать файлы, а не «похожесть картинок».
 */
function encodePng(rgba: Buffer): Buffer {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([head, typed, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const png = encodePng(iconBitmap())
const check = process.argv.includes('--check')

if (check) {
  if (!existsSync(iconPath)) {
    console.error(`✗ иконки нет: ${iconPath}`)
    process.exit(1)
  }
  const onDisk = readFileSync(iconPath)
  const same = onDisk.equals(png)
  const digest = (buffer: Buffer): string =>
    createHash('sha256').update(buffer).digest('hex').slice(0, 12)
  console.log(
    same
      ? `✓ иконка совпадает с макетом: ${SIZE}×${SIZE}, sha ${digest(png)}`
      : `✗ иконка разошлась с макетом: на диске ${digest(onDisk)}, из макета ${digest(png)}`,
  )
  process.exit(same ? 0 : 1)
}

mkdirSync(`${root}apps/desktop/packaging`, { recursive: true })
writeFileSync(iconPath, png)
console.log(`иконка нарисована: ${iconPath}, ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} КБ`)
