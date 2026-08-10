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
/**
 * Блоков у компонента может быть несколько — по одному на каждый контекст,
 * который он реализует.
 *
 * `AgentRow` и `LimitBar` нарисованы в макете дважды: в разделе 0 как
 * компоненты (строки 146–168 и 175–181) и внутри попапа (351–367 и 413–420), и
 * числа там разные — попап плотнее. Это не расхождение макета: раздел 0
 * показывает компонент в собственном контексте, попап — в своём, оба нарисованы
 * осознанно. Поэтому допустимые значения берутся объединением своих блоков, а
 * не сведением попапа к разделу 0 и не расширением проверки до «всего макета».
 */
const SPEC_LINES: Record<string, Array<[number, number]>> = {
  'AgentRow.tsx': [
    [146, 168],
    [351, 367],
  ],
  'LimitBar.tsx': [
    [175, 181],
    [413, 420],
  ],
  'TaskRow.tsx': [[186, 189]],
  'BreakdownRow.tsx': [
    [192, 200],
    [887, 891],
  ],
  // Рама, сетка и **обе колонки** нижней половины: поля колонок написаны здесь,
  // здесь же они и сверяются. Список инструментов — оттуда же (884–892).
  'TaskCard.tsx': [
    [836, 836],
    [866, 867],
    [884, 892],
  ],
  'TaskCardHeader.tsx': [[838, 848]],
  'TaskTimeline.tsx': [[851, 863]],
  'TokenSplit.tsx': [[867, 881]],
  'TaskFiles.tsx': [[893, 901]],
  // Сабагентов в макете нет: блок взят у соседа по колонке — «Затронутые
  // файлы» — и компонент свёрстан его числами. Довод в `design-implementation.md`.
  'TaskSubagents.tsx': [[893, 901]],
  // Сборка попапа: рама, контейнер списка агентов и контейнер лимитов.
  // Заголовки разделов сюда попадают потому, что их поля приходят отсюда же
  // параметром — у списка 14, у лимитов 16, и оба числа из макета.
  'Popup.tsx': [
    [332, 333],
    [342, 350],
    [406, 412],
  ],
  'PopupHeader.tsx': [[334, 340]],
  'SectionTitle.tsx': [
    [344, 347],
    [406, 409],
  ],
  'PopupLimit.tsx': [[413, 420]],
  'PopupFooter.tsx': [[442, 451]],
  'ProviderBadge.tsx': [
    [355, 355],
    [415, 415],
  ],
  // Настройки (3.6). Рама, список разделов и правая колонка — в `SettingsTab`;
  // каждая группа стоит в своём файле и сверяется со своим блоком, потому что
  // в макете они принадлежат разным пунктам списка. Блок тумблеров (1185–1192)
  // делят «Внешний вид» и «Приватность»: в макете это одна группа переключа-
  // телей, разложенная по смыслу на два раздела.
  'SettingsTab.tsx': [[1131, 1140]],
  'SettingsSources.tsx': [[1142, 1156]],
  'SettingsLimits.tsx': [[1158, 1179]],
  'SettingsAlerts.tsx': [[1181, 1195]],
  'SettingsAppearance.tsx': [[1197, 1204]],
  'SettingsPrivacy.tsx': [[1197, 1204]],
  'PopupEmpty.tsx': [[1215, 1223]],
  'PopupIndexing.tsx': [[1225, 1236]],
  'PopupProblem.tsx': [[1238, 1247]],
  'PopupIdle.tsx': [[1249, 1264]],
  'Window.tsx': [
    [564, 564],
    [588, 591],
  ],
  'WindowHeader.tsx': [
    [566, 566],
    [574, 577],
    [585, 585],
  ],
  'WindowTabs.tsx': [[568, 573]],
  'WindowLimit.tsx': [[577, 584]],
  'TodayTab.tsx': [
    [590, 590],
    [617, 617],
  ],
  'DaySummary.tsx': [[592, 600]],
  'TodayFilters.tsx': [[603, 611]],
  'TaskTable.tsx': [
    [613, 615],
    [617, 617],
  ],
  'TaskLine.tsx': [
    [619, 631],
    [647, 651],
  ],
  'FoldedTail.tsx': [[731, 731]],
  'TodaySide.tsx': [
    [735, 736],
    [752, 754],
  ],
  'HourChart.tsx': [[738, 749]],
  'ProjectBars.tsx': [[756, 761]],
  'SpendBar.tsx': [[767, 778]],
  // Развёртка (4.2): рама и полоса сверху — 927–955, левая колонка — 959–1046,
  // правая — 1049–1105, подпись под ней — 1107.
  'BreakdownTab.tsx': [
    [927, 955],
    [959, 1046],
    [1049, 1119],
  ],
  'SpendCategoryTable.tsx': [[971, 1040]],
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
  // Ноль — сброс браузерного отступа у `input`, а не значение из макета:
  // ползунок и тумблер нарисованы своими прямоугольниками, а системный элемент
  // лежит поверх невидимым. Довод — в `design-implementation.md`.
  'SettingsAlerts.tsx': [0],
  'SettingsPrivacy.tsx': [0],
}

const lines = html.split('\n')

function block(name: string): string {
  return (SPEC_LINES[name] ?? [])
    .map(([from, to]) => lines.slice(from - 1, to).join('\n'))
    .join('\n')
}

function specValues(name: string): Set<number> {
  return new Set([
    ...[...block(name).matchAll(/(?:gap|padding|margin)(?:-[a-z]+)?\s*:\s*([^;"']+)/g)].flatMap(
      ([, raw]) => [...raw.matchAll(/\d+/g)].map((n) => Number(n[0])),
    ),
    ...(OFF_SPEC[name] ?? []),
  ])
}

/**
 * Кегли и насыщенности — тоже из блока компонента, а не из общего списка.
 *
 * Раньше здесь стоял один набор на всех (11/12/13/15/20). Попап набран другими
 * ступенями — 9, 10 и 12.5, — и дописать их в общий список значило бы
 * разрешить `12.5` компонентам раздела 0, которым он не положен: проверка
 * ослабла бы ровно там, где уже работала. Правило то же, что у отступов: ответ
 * даёт свой блок макета.
 */
function specFontSizes(name: string): Set<number> {
  return new Set(
    [...block(name).matchAll(/font-size\s*:\s*([\d.]+)px/g)].map(([, raw]) => Number(raw)),
  )
}

function specFontWeights(name: string): Set<number> {
  return new Set(
    [...block(name).matchAll(/font-weight\s*:\s*(\d+)/g)].map(([, raw]) => Number(raw)),
  )
}

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
  // `[:=]`, а не `:`: отступ уезжает в компонент и свойством стиля
  // (`padding: '9px 12px'`), и пропом (`padding="14px 14px 4px"` в `Popup.tsx`).
  // Пока сверялось только первое, второе проходило мимо проверки вовсе — то
  // есть у любого компонента, принимающего поля параметром, числа не сверялись
  // ни с чем.
  const SPACING =
    /\b(?:rowGap|columnGap|padding|margin|gap)(?:Top|Left|Right|Bottom|Inline|Block|Start|End)?\s*[:=]\s*([^,}\n]+)/g

  for (const { name, src } of COMPONENTS) {
    it(`${name}: padding/margin/gap из своего блока макета`, () => {
      // Сторож границ блока: пустой **текст** блока значит, что диапазон в
      // `SPEC_LINES` съехал и сверять не с чем. Сторожить пустой набор чисел
      // нельзя — у контейнера без собственных отступов (`Window.tsx`) он пуст
      // законно, и требование «хоть одно число» заставило бы приписать
      // компоненту чужой блок макета.
      expect(block(name).length, `${name}: блок макета не найден`).toBeGreaterThan(0)
      const allowed = specValues(name)
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

// Ловит: кто-то поставил fontSize:14 или fontWeight:300 — кегль, которого нет
// в блоке этого компонента.
describe('типографика компонентов только из их блоков макета', () => {
  const SIZE = /\bfontSize\s*:\s*([^,}\n]+)/g
  const WEIGHT = /\bfontWeight\s*:\s*([^,}\n]+)/g

  for (const { name, src } of COMPONENTS) {
    it(`${name}: размер и насыщенность из своего блока макета`, () => {
      // Тот же сторож, что у отступов, и по той же причине: сверяется наличие
      // блока, а не наличие в нём чисел. У контейнера кеглей нет законно.
      expect(block(name).length, `${name}: блок макета не найден`).toBeGreaterThan(0)
      const sizes = specFontSizes(name)
      const code = stripComments(src)
      const badSizes: number[] = []
      for (const [, raw] of code.matchAll(SIZE)) {
        for (const n of raw.matchAll(/[\d.]+/g)) badSizes.push(Number(n[0]))
      }
      const weights = specFontWeights(name)
      const badWeights: number[] = []
      for (const [, raw] of code.matchAll(WEIGHT)) {
        for (const n of raw.matchAll(/\d+/g)) badWeights.push(Number(n[0]))
      }
      expect(badSizes.filter((n) => !sizes.has(n))).toEqual([])
      expect(badWeights.filter((n) => !weights.has(n))).toEqual([])
    })
  }
})
