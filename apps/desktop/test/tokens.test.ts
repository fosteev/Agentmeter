import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Сверка рендерера с макетом числами, не глазами. Список токенов не хардкодится:
// ожидание вытаскивается из design/Agentmeter.dc.html, поэтому тест не может
// пройти мимо собственного удаления. Каждая проверка ловит конкретную поломку.

const here = fileURLToPath(new URL('./', import.meta.url))
const root = fileURLToPath(new URL('../../../', import.meta.url))
const html = readFileSync(`${root}design/Agentmeter.dc.html`, 'utf8')
const css = readFileSync(`${here}../src/renderer/tokens.css`, 'utf8')
const componentsDir = `${here}../src/renderer/components`

const COMPONENTS = readdirSync(componentsDir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ name: f, src: readFileSync(`${componentsDir}/${f}`, 'utf8') }))

function parseRoot(text: string): Record<string, string> {
  // Комментарии внутри :root (в tokens.css они есть у структурных токенов)
  // иначе склеивают объявление с текстом, и indexOf(':') падает на двоеточие
  // в комментарии — переменная теряется.
  const block = (text.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Record<string, string> = {}
  for (const decl of block.split(';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) continue
    const name = decl.slice(0, colon).trim()
    const value = decl.slice(colon + 1).trim()
    if (name.startsWith('--')) out[name] = value
  }
  return out
}

// Комментарии вырезаем до сканирования стилей: в шапках компонентов есть
// пояснения с oklch-значениями и размерами, и они не должны считываться как
// код. Строковых литералов с // или /* в компонентах нет.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

/**
 * Отступы каждого компонента сверяются с его собственным блоком в макете.
 *
 * Не с набором 4/8/12/20/32: легенда в строках 100–107 («4 внутри строки,
 * 8 между строками, 12 поля попапа, 20 между блоками, 32 поля окна») описывает
 * ритм списка, а сами компоненты в строках 145–205 свёрстаны на `gap:10px`,
 * `padding:8px 10px` и `gap:3px`. Захардкоженный набор заставлял бы подгонять
 * вёрстку под тест, а эталон здесь макет — как фикстуры в парсерах.
 *
 * И не со всем разделом 0 сразу: туда попадает обвязка витрины (7, 14, 24),
 * и проверка перестаёт что-либо ловить. Границы блоков — из таблицы в
 * `docs/roadmap/design-implementation.md`.
 */
const SPEC_LINES: Record<string, [number, number]> = {
  'AgentRow.tsx': [146, 168],
  'LimitBar.tsx': [175, 181],
  'TaskRow.tsx': [186, 189],
  'BreakdownRow.tsx': [192, 200],
}

/**
 * Отступы элементов, которых в макете нет вовсе, — и откуда взято значение.
 *
 * Такой элемент ровно один и он назван в design-implementation.md («Чего в
 * макете нет»): подпись прогноза под полосой лимита, этап 2.3. Своего ответа
 * блок полосы на неё не даёт — в нём только зазоры между полосами. Взят ответ
 * макета на то же отношение из блока строки агента: там строка и её тихая
 * подпись стоят на 3.
 *
 * Список закрытый и требует строки в документе: без него правило «отступы из
 * своего блока» превращается в «любое число, если написать комментарий».
 */
const OFF_SPEC: Record<string, number[]> = {
  'LimitBar.tsx': [3],
}

function specValues(name: string): Set<number> {
  const [from, to] = SPEC_LINES[name] ?? [0, 0]
  const block = html
    .split('\n')
    .slice(from - 1, to)
    .join('\n')
  return new Set([
    ...[...block.matchAll(/(?:gap|padding|margin)(?:-[a-z]+)?\s*:\s*([^;"']+)/g)].flatMap(
      ([, raw]) => [...raw.matchAll(/\d+/g)].map((n) => Number(n[0])),
    ),
    ...(OFF_SPEC[name] ?? []),
  ])
}

const FONT_SIZES = new Set([11, 12, 13, 15, 20])
const FONT_WEIGHTS = new Set([400, 600])

// Ловит: кто-то поменял цвет в tokens.css или выкинул токен из макета.
describe('tokens.css :root совпадает с макетом посимвольно', () => {
  const designRoot = parseRoot(html)
  const cssRoot = parseRoot(css)

  it('каждая переменная макета присутствует в tokens.css тем же значением', () => {
    const missing: string[] = []
    const drifted: string[] = []
    for (const [name, value] of Object.entries(designRoot)) {
      if (!(name in cssRoot)) missing.push(name)
      else if (cssRoot[name] !== value) drifted.push(`${name}: ${value} → ${cssRoot[name]}`)
    }
    expect({ missing, drifted }).toEqual({ missing: [], drifted: [] })
  })
})

// Ловит: --row-h задали 43px или переименовали токен высоты строки.
describe('структурные токены из строки 107 макета', () => {
  const cssRoot = parseRoot(css)

  it('высоты строк 44/40 и радиусы 6/10 на месте', () => {
    expect(cssRoot['--row-h']).toBe('44px')
    expect(cssRoot['--row-h-popup']).toBe('40px')
    expect(cssRoot['--r-inner']).toBe('6px')
    expect(cssRoot['--r-card']).toBe('10px')
  })
})

// Ловит: в компоненте появился padding:7 или margin:6 — отступ, которого нет
// нигде в разделе 0 макета.
describe('отступы компонентов только из значений раздела 0', () => {
  const SPACING =
    /\b(?:rowGap|columnGap|padding|margin|gap)(?:Top|Left|Right|Bottom|Inline|Block|Start|End)?\s*:\s*([^,}\n]+)/g

  for (const { name, src } of COMPONENTS) {
    it(`${name}: padding/margin/gap из своего блока макета`, () => {
      const allowed = specValues(name)
      // Пустой набор значил бы, что границы блока съехали и проверять нечего.
      expect(allowed.size, `${name}: блок макета не найден`).toBeGreaterThan(0)
      const off: number[] = []
      for (const [, raw] of src.matchAll(SPACING)) {
        for (const n of raw.matchAll(/\d+/g)) off.push(Number(n[0]))
      }
      expect(off.filter((n) => !allowed.has(n))).toEqual([])
    })
  }
})

// Ловит: в компонент вписали #fff или oklch(...) напрямую вместо var(--...).
// color-mix(in oklch, var(--warn) 32%, transparent) проходит: после oklch нет
// скобки, а transparent/currentColor — не цветовые литералы.
describe('в компонентах нет цветовых литералов мимо переменных', () => {
  const COLOR_LITERAL =
    /(?:oklch|rgba?|hsla?|lab|lch)\s*\(|#[0-9a-fA-F]{3,8}\b|\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|brown|cyan|magenta|teal|navy|maroon|olive)\b/gi

  for (const { name, src } of COMPONENTS) {
    it(`${name}: цвета только через var()`, () => {
      const code = stripComments(src)
      const hits = code.match(COLOR_LITERAL) ?? []
      expect(hits).toEqual([])
    })
  }
})

// Ловит: кто-то поставил fontSize:14 или fontWeight:300 — мимо ступеней 0.
describe('типографика компонентов только из шести ступеней раздела 0', () => {
  const SIZE = /\bfontSize\s*:\s*([^,}\n]+)/g
  const WEIGHT = /\bfontWeight\s*:\s*([^,}\n]+)/g

  for (const { name, src } of COMPONENTS) {
    it(`${name}: размер и насыщенность из ступеней`, () => {
      const badSizes: number[] = []
      for (const [, raw] of src.matchAll(SIZE)) {
        for (const n of raw.matchAll(/\d+/g)) badSizes.push(Number(n[0]))
      }
      const badWeights: number[] = []
      for (const [, raw] of src.matchAll(WEIGHT)) {
        for (const n of raw.matchAll(/\d+/g)) badWeights.push(Number(n[0]))
      }
      expect(badSizes.filter((n) => !FONT_SIZES.has(n))).toEqual([])
      expect(badWeights.filter((n) => !FONT_WEIGHTS.has(n))).toEqual([])
    })
  }
})
