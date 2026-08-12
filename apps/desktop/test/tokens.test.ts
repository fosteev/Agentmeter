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
 * компоненты (строки 146–168 и 175–181) и внутри попапа (356–372 и 433–440), и
 * числа там разные — попап плотнее. Это не расхождение макета: раздел 0
 * показывает компонент в собственном контексте, попап — в своём, оба нарисованы
 * осознанно. Поэтому допустимые значения берутся объединением своих блоков, а
 * не сведением попапа к разделу 0 и не расширением проверки до «всего макета».
 */
const SPEC_LINES: Record<string, Array<[number, number]>> = {
  'AgentRow.tsx': [
    [146, 168],
    [356, 372],
  ],
  'LimitBar.tsx': [
    [175, 181],
    [433, 440],
  ],
  'TaskRow.tsx': [[186, 189]],
  'BreakdownRow.tsx': [
    [192, 200],
    [926, 930],
  ],
  // Рама, сетка и **обе колонки** нижней половины: поля колонок написаны здесь,
  // здесь же они и сверяются. Список инструментов — оттуда же (923–931).
  'TaskCard.tsx': [
    [875, 875],
    [889, 889],
    [905, 906],
    [923, 931],
  ],
  'TaskCardHeader.tsx': [[877, 887]],
  'TaskTimeline.tsx': [[890, 902]],
  'TokenSplit.tsx': [[906, 920]],
  'TaskFiles.tsx': [[932, 940]],
  // Сабагентов в макете нет: блок взят у соседа по колонке — «Затронутые
  // файлы» — и компонент свёрстан его числами. Довод в `design-implementation.md`.
  'TaskSubagents.tsx': [[932, 940]],
  // Сборка попапа: рама, контейнер списка агентов и контейнер лимитов.
  // Заголовки разделов сюда попадают потому, что их поля приходят отсюда же
  // параметром — у списка 14, у лимитов 16, и оба числа из макета.
  // Рама попапа стоит отдельным компонентом: пять состояний носят её одну.
  'PopupShell.tsx': [[332, 333]],
  'Popup.tsx': [
    [347, 355],
    [411, 432],
  ],
  'PopupHeader.tsx': [[334, 345]],
  'SectionTitle.tsx': [
    [349, 352],
    [411, 414],
  ],
  'PopupLimit.tsx': [[433, 440]],
  // Правая часть заголовка блока лимитов — та же строка макета, что у подписи
  // «≈ оценка» (413), плюс рамка заголовка (411). Кнопка «спросить» рисуется
  // теми же 10 px и той же линией, других чисел у неё нет.
  'LimitsAside.tsx': [[411, 414]],
  'PopupFooter.tsx': [[462, 471]],
  // Бейдж остался в одном контексте вместо двух: в строке лимита его больше нет,
  // провайдера там называет таб (макет, 416–429). Второй якорь снят вместе с
  // ним — диапазон, показывающий не то, что нарисовано, хуже отсутствующего.
  'ProviderBadge.tsx': [[360, 360]],
  // Настройки (3.6). Рама, список разделов и правая колонка — в `SettingsTab`;
  // каждая группа стоит в своём файле и сверяется со своим блоком, потому что
  // в макете они принадлежат разным пунктам списка. Блок тумблеров (1224–1231)
  // делят «Внешний вид» и «Приватность»: в макете это одна группа переключа-
  // телей, разложенная по смыслу на два раздела.
  'SettingsTab.tsx': [[1170, 1179]],
  'SettingsSources.tsx': [[1181, 1195]],
  'SettingsLimits.tsx': [[1197, 1218]],
  // «Настоящие лимиты Claude» (1.9) — блок раздела «Лимиты», и свёрстан он
  // числами карточки потолков: это тот же вид карточки в той же колонке, а
  // своего блока в макете у него нет — макет рисовался до находки. Довод — в
  // `design-implementation.md`.
  'SettingsUsage.tsx': [[1197, 1218]],
  'SettingsAlerts.tsx': [[1220, 1234]],
  'SettingsAppearance.tsx': [[1236, 1243]],
  'SettingsPrivacy.tsx': [[1236, 1243]],
  'SettingsApp.tsx': [[1236, 1243]],
  // Тумблер вынесен из «Приватности» в 5.3 — он же стоит в «Приложении».
  'Switch.tsx': [[1236, 1243]],
  'PopupEmpty.tsx': [[1254, 1262]],
  'PopupIndexing.tsx': [[1264, 1275]],
  'PopupProblem.tsx': [[1277, 1286]],
  'PopupIdle.tsx': [[1288, 1303]],
  'Window.tsx': [
    [603, 603],
    [627, 630],
  ],
  'WindowHeader.tsx': [
    [605, 605],
    [613, 616],
    [624, 624],
  ],
  'WindowTabs.tsx': [[607, 612]],
  'WindowLimit.tsx': [[616, 623]],
  'TodayTab.tsx': [
    [629, 629],
    [656, 656],
  ],
  'DaySummary.tsx': [[631, 639]],
  'TodayFilters.tsx': [[642, 650]],
  'TaskTable.tsx': [
    [652, 654],
    [656, 656],
  ],
  'TaskLine.tsx': [
    [658, 670],
    [686, 690],
  ],
  // Живая подпись (6.1) дорисована в макет после факта — двумя контекстами, как
  // `AgentRow`: строкой ленты (658–670) и полосой в карточке задачи (889).
  // Чужих блоков не занимает: до правки макета она стояла на заимствованных, и
  // это было временным решением, а не правилом.
  'TaskLive.tsx': [
    [658, 670],
    [889, 889],
  ],
  'FoldedTail.tsx': [[770, 770]],
  'TodaySide.tsx': [
    [774, 775],
    [791, 793],
  ],
  'HourChart.tsx': [[777, 788]],
  'ProjectBars.tsx': [[795, 800]],
  'SpendBar.tsx': [[806, 817]],
  // Развёртка (4.2): рама и полоса сверху — 966–994, левая колонка — 998–1085,
  // правая — 1088–1144, подпись под ней — 1146.
  'BreakdownTab.tsx': [
    [966, 994],
    [998, 1085],
    [1088, 1158],
  ],
  'SpendCategoryTable.tsx': [[1010, 1079]],
  // Подсказки состава (4.9) в макете нет — он рисовался до неё. Блок взят у
  // строки, которую подсказка раскрывает: карточка стоит в той же колонке того
  // же раздела и набрана её же ступенями. Довод — в `design-implementation.md`.
  'SpendDetail.tsx': [[1010, 1079]],
  // Переплата за паузу (4.4) — карточка раздела 10 целиком, от рамы до подписи
  // под ней. Строка 1778 («Показать эти 24 паузы в ленте») в компоненте не
  // реализована: фильтра «паузы» у ленты нет, а кнопка без поведения хуже её
  // отсутствия (правило 3.6). Диапазон включает её, потому что режется по
  // границам блока макета, а не по тому, что мы из него взяли.
  'CacheRebuilds.tsx': [[1704, 1780]],
  // История (4.6) — раздел 8. Рама и сетка вкладки плюс шапка периода со
  // счётчиком; светлая версия (8б) новых чисел не приносит, это проверка
  // токенов цвета.
  // Пустой экран истории в макете не нарисован — там нарисована история с
  // данными. Числа взяты у пустого экрана развёртки (966–970), потому что это
  // тот же вид сообщения в том же месте; довод — в `design-implementation.md`
  // рядом с таким же заимствованием у `TaskSubagents`.
  'HistoryTab.tsx': [
    [966, 970],
    [1326, 1328],
    [1330, 1342],
    [1382, 1382],
  ],
  'HistoryBars.tsx': [[1344, 1379]],
  'HistoryHeatmap.tsx': [[1384, 1434]],
  'HistorySide.tsx': [[1437, 1489]],
}

/**
 * Отступы элементов, которых в макете нет вовсе, — и откуда взято значение.
 *
 * Первый такой элемент назван в design-implementation.md («Чего в макете нет»):
 * подпись прогноза под полосой лимита, этап 2.3. Своего ответа блок полосы на
 * неё не даёт — в нём только зазоры между полосами. Взят ответ макета на то же
 * отношение из блока строки агента: там строка и её тихая подпись стоят на 3.
 *
 * Список закрытый и требует строки в документе: без него правило «отступы из
 * своего блока» превращается в «любое число, если написать комментарий».
 */
const OFF_SPEC: Record<string, number[]> = {
  'LimitBar.tsx': [3],
  // Шесть — отступ справа у бейджа провайдера в строке лимита. В макете он был
  // до третьей правки (строка 415), а теперь провайдера называет таб, и бейджа
  // там нет. Число доживает вместе с бейджем: снять его сейчас значит оставить
  // пять окон двух провайдеров одним списком без подписи, чьи они. Уходит
  // вместе с бейджем в 7.1 — до тех пор макет опережает код, а не наоборот.
  'PopupLimit.tsx': [6],
  // Ноль — сброс браузерного отступа у `input`, а не значение из макета:
  // ползунок и тумблер нарисованы своими прямоугольниками, а системный элемент
  // лежит поверх невидимым. Довод — в `design-implementation.md`.
  'SettingsAlerts.tsx': [0],
  'Switch.tsx': [0],
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
