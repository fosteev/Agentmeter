/**
 * Снимки экранов для README — из макета (5.5). Main-процесс Electron.
 *
 * Запускается не отсюда: `node scripts/make-shots.js` находит бинарник Electron
 * и подсовывает ему этот каталог. Каталог с `package.json`, а не один файл,
 * потому что одиночный `.js` Electron 43 молча не запускает — ни строки в
 * выводе, ни кода возврата, просто пустой процесс.
 *
 * **`await app.whenReady()` на верхнем уровне здесь висит навсегда.** У
 * ESM-входа Electron ждёт, пока модуль домчит до конца, и только потом сообщает
 * `ready` — то есть верхнеуровневое ожидание готовности ждёт само себя. Ловушка
 * тихая: процесс живой, окон нет, вывода нет. Поэтому работа висит на
 * `whenReady().then(...)`, а не на `await`.
 *
 * Почему снимки из макета, а не из приложения: снимок живого окна показывает
 * мои проекты, ветки и промпты, а вычистить их нечем, кроме тумблеров
 * приватности, которые заодно убирают половину смысла экрана. Макет же и есть
 * эталон вёрстки, и состояния в нём расставлены нарочно — два агента разных
 * провайдеров, точный процент Codex рядом с оценкой Claude, совет про
 * неиспользованный сервер.
 *
 * Шрифты подключаются файлами из репозитория: в макете они с Google Fonts, и
 * без сети вёрстка поехала бы на системных подстановках — молча и
 * правдоподобно.
 *
 * Подписи заменяются английскими по словарю (`dictionary.js`) — в памяти
 * страницы, а не правкой макета: он эталон вёрстки, и его строки держат
 * числовую приёмку. Кадр после замены проверяется на кириллицу: снимок с
 * половиной подписей на русском читается как недоделка, а заметить это на
 * шести картинках глазами — вопрос везения.
 */
import { app, BrowserWindow } from 'electron'
import { DICTIONARY } from './dictionary.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const design = join(root, 'design/Agentmeter.dc.html')
const outDir = join(root, 'docs/screenshots')
const fontsDir = join(root, 'apps/desktop/src/renderer/fonts')

/**
 * Что снимаем. Ключ — подпись раздела в макете, а не номер строки: строки
 * сдвигаются на каждой правке дизайна (так уже было в M4), а подписи держатся.
 * Внутри раздела берётся первый экран — в разделе 2 их два, тёмный и светлый.
 */
const SHOTS = [
  { file: 'popup.png', label: '2 · Попап' },
  { file: 'today.png', label: '3 · Главное окно' },
  { file: 'task.png', label: '4 · Карточка задачи' },
  { file: 'breakdown.png', label: '5 · Вкладка «Развёртка»' },
  { file: 'settings.png', label: '6 · Настройки' },
  { file: 'history.png', label: '8 · Вкладка «История»' },
]

const FONTS = [
  ['IBM Plex Sans', 400, 'IBMPlexSans-Regular.woff2'],
  ['IBM Plex Sans', 500, 'IBMPlexSans-Medium.woff2'],
  ['IBM Plex Sans', 600, 'IBMPlexSans-SemiBold.woff2'],
  ['IBM Plex Mono', 400, 'IBMPlexMono-Regular.woff2'],
  ['IBM Plex Mono', 500, 'IBMPlexMono-Medium.woff2'],
  ['IBM Plex Mono', 600, 'IBMPlexMono-SemiBold.woff2'],
]

app.whenReady().then(capture, (error) => {
  console.error(error)
  app.exit(1)
})

async function capture() {
  mkdirSync(outDir, { recursive: true })

  // Окно выше любого экрана в макете: `capturePage` снимает видимую область, и
  // высокий раздел иначе обрезался бы снизу — тихо, потому что верх картинки
  // при этом выглядит правильным.
  const window = new BrowserWindow({
    width: 1360,
    height: 1600,
    show: false,
    webPreferences: { offscreen: true },
  })
  await window.loadFile(design)
  await window.webContents.executeJavaScript(fontPatch())

  const failures = []
  const applied = await window.webContents.executeJavaScript(translate())
  console.log(
    `словарь: заменено ${applied.replaced} из ${DICTIONARY.length}, убрано ${applied.dropped}`,
  )
  // Правило, которое перестало срабатывать, выглядит как «всё в порядке»:
  // словарь, промахнувшийся мимо макета целиком, дал бы русские снимки и ни
  // одной жалобы.
  if (applied.replaced === 0) failures.push('словарь не заменил ни одной подписи')
  if (applied.dropped === 0) failures.push('словарь не убрал ни одного лишнего блока')

  for (const shot of SHOTS) {
    const box = await window.webContents.executeJavaScript(measure(shot.label))
    if (box === null) {
      failures.push(`${shot.file}: в макете нет раздела «${shot.label}»`)
      continue
    }
    const left = await window.webContents.executeJavaScript(cyrillic(shot.label))
    if (left.length > 0) {
      failures.push(`${shot.file}: осталось по-русски — ${left.slice(0, 3).join(' · ')}`)
    }
    // Ещё одна пауза уже в main: страница о своей перерисовке не сообщает, а
    // безоконный рендер догоняет её не мгновенно.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const image = await window.webContents.capturePage(box)
    const png = image.toPNG()
    const size = image.getSize()
    writeFileSync(join(outDir, shot.file), png)
    console.log(
      `${shot.file}: ${size.width}×${size.height} (×${(size.width / box.width).toFixed(1)}), ` +
        `${(png.length / 1024).toFixed(0)} КБ`,
    )
    // Пустой снимок — не теория: страница могла не докрутиться, а `capturePage`
    // вернул бы ровный прямоугольник фона. Восемь килобайт на экран в 1180
    // точек не бывает ни у одного из них.
    if (size.width < box.width) failures.push(`${shot.file}: снимок мельче макета`)
    if (png.length < 8_000) failures.push(`${shot.file}: снимок подозрительно пустой`)
  }

  for (const line of failures) console.error(`✗ ${line}`)
  app.exit(failures.length === 0 ? 0 : 1)
}

/**
 * Подключение шрифтов файлами из репозитория и ожидание их загрузки.
 *
 * Без ожидания снимок успевает сняться на подстановке: `font-display: swap`
 * рисует первым системным шрифтом, и разница видна только в кернинге — то есть
 * на картинке, которую уже никто не переснимет.
 */
function fontPatch() {
  const faces = FONTS.map(
    ([family, weight, file]) =>
      `@font-face{font-family:'${family}';font-weight:${weight};font-display:block;` +
      `src:url('${pathToFileURL(join(fontsDir, file)).href}') format('woff2')}`,
  ).join('\n')
  return `(async () => {
    const style = document.createElement('style')
    style.textContent = ${JSON.stringify(faces)}
    document.head.append(style)
    await document.fonts.ready
    // Пульсирующая точка «работает» в макете анимирована, и снимок обязан
    // ловить её в одной фазе — иначе на разных картинках она разной яркости.
    for (const node of document.querySelectorAll('*')) node.style.animation = 'none'
    return true
  })()`
}

/**
 * Прямоугольник экрана внутри раздела.
 *
 * Раздел находится по подписи, экран внутри него — по своей же рамке:
 * скругление в 12 точек, обрезка содержимого и ширина от трёхсот точек. Ширина
 * в правиле не для красоты — тем же скруглением нарисованы карточки внутри
 * экранов, и без неё снимок оказался бы снимком карточки.
 *
 * Стиль читается **вычисленным**, а не строкой атрибута: браузер
 * пересобирает `style` по-своему (`border-radius:12px` превращается в
 * `border-radius: 12px`), и поиск по подстроке молча не находит ничего.
 *
 * Подпись раздела лежит в глубине, а внутри неё экрана нет — поиск идёт от
 * родителя. Из нескольких узлов, чей текст начинается с подписи, берётся
 * последний: первые — обёртки, у которых подпись просто первая внутри.
 */
function measure(label) {
  return `(async () => {
    const heads = [...document.querySelectorAll('div')].filter(
      (node) => node.textContent.trim().startsWith(${JSON.stringify(label)}),
    )
    const head = heads.at(-1)
    if (!head) return null
    const scope = head.children.length > 0 ? head : head.parentElement
    const screen = [...scope.querySelectorAll('div')].find((node) => {
      const style = getComputedStyle(node)
      return (
        style.borderTopLeftRadius === '12px' &&
        style.overflow === 'hidden' &&
        node.getBoundingClientRect().width >= 300
      )
    })
    if (!screen) return null
    const start = screen.getBoundingClientRect()
    window.scrollTo(Math.max(0, window.scrollX + start.x - 24), window.scrollY + start.y - 24)
    // Прокрутка сама по себе снимка не двигает: кадр перерисовывается позже, и
    // снимок успевает взять предыдущий. Проверено дорого — первый заход
    // выдал шесть картинок с шапкой макета вместо шести разных экранов, причём
    // каждая была настоящей картинкой настоящей страницы.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const rect = screen.getBoundingClientRect()
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  })()`
}

/**
 * Замена подписей по словарю и снятие блоков, которых в продукте нет.
 *
 * Сравнение — по всему тексту узла целиком, а не по вхождению подстроки: так
 * «все» из фильтра ленты не превращает в «all» половину слова в соседнем
 * абзаце. Узлы перебираются один раз и заменяются на месте, порядок правил
 * значения не имеет.
 */
function translate() {
  return `(() => {
    const dictionary = new Map(${JSON.stringify(DICTIONARY)})
    let replaced = 0
    let dropped = 0
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) {
      const value = node.nodeValue
      const key = value.trim()
      const to = dictionary.get(key)
      if (to === undefined) continue
      if (to === '__DROP_SELF__' || to === '__DROP_ROW__') {
        let target = node.parentElement
        if (to === '__DROP_ROW__') {
          while (target && !getComputedStyle(target).gridTemplateColumns.includes(' ')) {
            target = target.parentElement
          }
        }
        if (target) {
          target.remove()
          dropped += 1
        }
        continue
      }
      // Пробелы вокруг сохраняются: в макете есть узлы вида «Плагины ␣3», где
      // соседний пробел держит вёрстку строки.
      node.nodeValue = value.replace(key, to)
      replaced += 1
    }
    return { replaced, dropped }
  })()`
}

/** Что осталось по-русски внутри снимаемого экрана — список для жалобы. */
function cyrillic(label) {
  return `(() => {
    const heads = [...document.querySelectorAll('div')].filter(
      (node) => node.textContent.trim().startsWith(${JSON.stringify(label)}),
    )
    const head = heads.at(-1)
    if (!head) return []
    const scope = head.children.length > 0 ? head : head.parentElement
    const screen = [...scope.querySelectorAll('div')].find((node) => {
      const style = getComputedStyle(node)
      return (
        style.borderTopLeftRadius === '12px' &&
        style.overflow === 'hidden' &&
        node.getBoundingClientRect().width >= 300
      )
    })
    if (!screen) return []
    const left = new Set()
    const walker = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = walker.currentNode.nodeValue.trim()
      if (text && /[А-Яа-яЁё]/.test(text)) left.add(text)
    }
    return [...left]
  })()`
}
