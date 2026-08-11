/**
 * Смоук **упакованного** приложения (5.1).
 *
 *     npm run -w @agentmeter/desktop package:dir
 *     node --experimental-strip-types scripts/probe/package-smoke.ts
 *
 * `desktop-smoke.ts` проверяет собранное приложение, запуская его бинарником
 * Electron из node_modules. Здесь проверяется другое: то, что уедет
 * пользователю. Между ними ровно те поломки, которых больше нигде не видно —
 * файл, не попавший в `files`, путь, который в asar читается иначе, чем на
 * диске, и зависимость, оставшаяся в devDependencies.
 *
 * Десять проверок, каждая названа по поломке, которую обязана поймать.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const release = join(root, 'release')
const configPath = join(root, 'apps/desktop/electron-builder.yml')

let failed = false

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}

interface Packaged {
  dir: string
  binary: string
  asar: string
  resources: string
}

/**
 * Где распакованное приложение — по платформе, а не по угадыванию.
 *
 * Каталогов в `release/` бывает несколько: сборка под две архитектуры кладёт
 * `mac` и `mac-arm64` рядом. Берётся **самый свежий**, и это не мелочь: первый
 * попавшийся однажды оказался позавчерашним, проверки зеленели на приложении,
 * которого уже нет, и красной стала только седьмая — та, что и написана про
 * этот случай.
 */
function findApp(): Packaged | null {
  if (!existsSync(release)) return null
  const found = readdirSync(release, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => candidate(join(release, entry.name)))
    .filter((one): one is Packaged => one !== null)
  if (found.length === 0) return null
  return found.sort((left, right) => statSync(right.asar).mtimeMs - statSync(left.asar).mtimeMs)[0]!
}

function candidate(dir: string): Packaged | null {
  {
    if (process.platform === 'darwin') {
      const app = readdirSync(dir).find((name) => name.endsWith('.app'))
      if (app === undefined) return null
      const resources = join(dir, app, 'Contents/Resources')
      return {
        dir: join(dir, app),
        binary: join(dir, app, 'Contents/MacOS', app.replace(/\.app$/, '')),
        asar: join(resources, 'app.asar'),
        resources,
      }
    }
    const binary =
      process.platform === 'win32' ? join(dir, 'Agentmeter.exe') : join(dir, 'agentmeter')
    if (!existsSync(binary)) return null
    return { dir, binary, asar: join(dir, 'resources/app.asar'), resources: join(dir, 'resources') }
  }
}

/**
 * Оглавление asar без единой зависимости.
 *
 * Формат: четыре 32-битных числа, за ними JSON дерева. Читать его пакетом
 * `asar` из сети ради одной проверки — значит поставить пробу в зависимость от
 * реестра npm; проба обязана работать там, где собирают.
 */
function asarEntries(path: string): string[] {
  const head = readFileSync(path)
  const jsonSize = head.readUInt32LE(12)
  const tree = JSON.parse(head.subarray(16, 16 + jsonSize).toString('utf8')) as {
    files: Record<string, unknown>
  }
  const out: string[] = []
  const walk = (node: { files?: Record<string, unknown> }, prefix: string): void => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const child = value as { files?: Record<string, unknown> }
      const full = `${prefix}/${name}`
      if (child.files) walk(child, full)
      else out.push(full)
    }
  }
  walk(tree, '')
  return out
}

function newestUnder(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestUnder(path) : statSync(path).mtimeMs)
  }
  return newest
}

const app = findApp()

// 1. Ловит: пробу, запущенную до упаковки. Без приложения все остальные
//    проверки зелены по-пустому — это ровно тот случай, когда «проверка на
//    пустом входе зелена всегда».
report(
  1,
  'упакованное приложение на месте',
  app === null ? `в ${release} нет собранного приложения` : app.dir.replace(root, ''),
  app !== null,
)

// 2. Ловит: версию Electron, вписанную в конфиг числом и отставшую от
//    установленной. Число там вынужденное — упаковщик не умеет диапазон в
//    монорепо, — и разъехаться ему не с чем, кроме этой проверки: собранное
//    приложение будет работать, просто не на том Electron, который проверяли
//    тесты.
const installed = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
) as { version: string }
const pinned = readFileSync(configPath, 'utf8').match(/^electronVersion:\s*(\S+)/m)?.[1]
report(
  2,
  'версия Electron в конфиге упаковки — установленная',
  `конфиг ${pinned ?? '—'}, node_modules ${installed.version}`,
  pinned === installed.version,
)

// 3. Ловит: приложение, которое собралось, но не работает у пользователя —
//    потерянный preload, ненайденная страница окна, зависимость, оставшаяся
//    снаружи asar. Запускается **из чужого каталога**: собранное приложение не
//    имеет права зависеть от того, что рядом лежит репозиторий.
const away = mkdtempSync(join(tmpdir(), 'agentmeter-package-'))
const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']
const run =
  app === null
    ? { status: 1, stdout: '' }
    : spawnSync(app.binary, ['--smoke'], { encoding: 'utf8', cwd: away, env, timeout: 120_000 })
let payload: {
  electron?: string
  chrome?: string
  problems?: string[]
  window?: { page?: string }
  tray?: { empty?: boolean }
  startup?: { enabled?: boolean; available?: boolean; reason?: string }
  updater?: { module?: boolean; error?: string }
  snapshot?: { at?: number; today?: { total?: { value?: number } } }
} = {}
try {
  payload = JSON.parse((run.stdout ?? '').trim().split('\n').at(-1) ?? '{}')
} catch {
  payload = {}
}
const alive =
  run.status === 0 &&
  Boolean(payload.electron) &&
  Boolean(payload.chrome) &&
  payload.window?.page === 'window.html' &&
  payload.tray?.empty === false &&
  typeof payload.snapshot?.today?.total?.value === 'number'
report(
  3,
  'запускается вне репозитория, поднимает окно и трей',
  alive
    ? `electron ${payload.electron}, chrome ${payload.chrome}, сумма за сутки ${payload.snapshot?.today?.total?.value}`
    : `exit=${run.status}, проблемы: ${(payload.problems ?? []).join(' · ') || 'вывода нет'}`,
  alive,
)

// 4. Ловит: подмену Electron нодой в упакованном виде. У собранного приложения
//    она невозможна иначе, чем в разработке: бинарник под этой переменной
//    становится нодой и на `--smoke` отвечает «bad option», не дойдя до main.
//    Проверка всё равно нужна — она доказывает, что зелёный результат нельзя
//    получить с выставленной переменной ни одним из двух способов.
const asNode =
  app === null
    ? { status: 0, stdout: '' }
    : spawnSync(app.binary, ['--smoke'], {
        encoding: 'utf8',
        cwd: away,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 120_000,
      })
rmSync(away, { recursive: true, force: true })
report(
  4,
  'под ELECTRON_RUN_AS_NODE упакованное приложение падает',
  asNode.status === 0
    ? 'вышло нулём — снимок собран нодой, а не Electron'
    : `exit=${asNode.status}, снимка нет`,
  asNode.status !== 0 && !(asNode.stdout ?? '').includes('"snapshot"'),
)

// 5. Ловит: asar, в который уехал репозиторий. Исходники на TypeScript внутри
//    сборки не запускаются никогда, но читаются как «здесь можно править», а
//    витрина компонентов — инструмент верстальщика, которому у пользователя
//    делать нечего.
const entries = app === null ? [] : asarEntries(app.asar)
const leaked = entries.filter(
  (name) =>
    name.endsWith('.ts') ||
    name.endsWith('.map') ||
    name.endsWith('.tsbuildinfo') ||
    name.includes('gallery'),
)
const needed = ['/dist/main/index.js', '/dist/preload/index.cjs', '/dist/web/window.html']
const missing = needed.filter((name) => !entries.includes(name))
report(
  5,
  'внутри asar только приложение',
  `файлов ${entries.length}, лишних ${leaked.length}${leaked.length ? ` (${leaked.slice(0, 3).join(', ')})` : ''}, потерянных ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`,
  entries.length > 0 && leaked.length === 0 && missing.length === 0,
)

// 6. Ловит: иконку, нарисованную прошлой версией генератора, и иконку, не
//    доехавшую до бандла. Первое тихо: приложение с иконкой из старых токенов
//    выглядит рабочим.
const icon = spawnSync(
  process.execPath,
  ['--experimental-strip-types', join(root, 'scripts/make-icon.ts'), '--check'],
  { encoding: 'utf8' },
)
const bundled =
  app === null
    ? []
    : readdirSync(app.resources).filter((name) => /\.(icns|ico|png)$/.test(name)).length > 0 ||
      existsSync(join(app.dir, 'Contents/Resources/electron.icns'))
report(
  6,
  'иконка совпадает с макетом и лежит в бандле',
  `${(icon.stdout ?? '').trim().split('\n').at(-1) ?? 'генератор молчит'}${bundled === false ? ', в бандле её нет' : ''}`,
  icon.status === 0 && bundled !== false,
)

// 7. Ловит: пробу на позавчерашней упаковке. Собранное новее упакованного
//    значит, что проверялось приложение, которого уже нет.
const builtAt = newestUnder(join(root, 'apps/desktop/dist'))
const packedAt = app === null ? 0 : statSync(app.asar).mtimeMs
report(
  7,
  'упаковка не отстала от сборки',
  app === null
    ? 'приложения нет'
    : `asar на ${Math.round((packedAt - builtAt) / 1000)} с новее самого свежего файла dist`,
  packedAt >= builtAt,
)

// 8. Ловит: автозапуск (5.3), недоступный именно там, где он и нужен. В
//    разработке он всегда выключен и подписан причиной, и проверка на
//    неупакованном приложении зелена по-пустому: `available: false` там —
//    правильный ответ. Настоящий ответ виден только здесь. Включать его проба
//    не имеет права: это запись в «Объекты входа» того, кто её запустил.
const startup = payload.startup
report(
  8,
  'в установленном приложении автозапуск доступен и не включён сам собой',
  startup === undefined
    ? 'приложение не отчиталось об автозапуске'
    : `доступен=${startup.available}, включён=${startup.enabled}${startup.reason === undefined ? '' : `, причина: ${startup.reason}`}`,
  startup?.available === true && startup.enabled === false,
)


// 9. Ловит: автообновление (5.4), не доехавшее до сборки, — двумя разными
//    способами. Загрузчик мог остаться в devDependencies и не попасть в asar;
//    адрес релизов мог не попасть в бандл, и тогда приложение искало бы
//    обновления неизвестно где. Сети здесь нет ни байта: модуль только
//    загружается, а адрес читается файлом.
const feedPath = app === null ? null : join(app.resources, 'app-update.yml')
const feed = feedPath !== null && existsSync(feedPath) ? readFileSync(feedPath, 'utf8') : null
const wanted = readFileSync(configPath, 'utf8')
const owner = wanted.match(/^\s+owner:\s*(\S+)/m)?.[1]
const repo = wanted.match(/^\s+repo:\s*(\S+)/m)?.[1]
// `--dir` адрес в бандл не пишет вовсе — это не поломка, но и не проверка.
// Молчать о пропущенном нельзя: пропуск, о котором не сказано, читается как
// «проверено».
const addressed =
  feed === null
    ? 'адрес не проверен: сборка --dir его не пишет'
    : feed.includes(`owner: ${owner}`) && feed.includes(`repo: ${repo}`)
      ? `адрес ${owner}/${repo}`
      : `адрес в сборке разошёлся с конфигом: ${feed.replace(/\n/g, ' ').trim()}`
report(
  9,
  'загрузчик обновлений внутри сборки, адрес релизов — из конфига',
  `${payload.updater?.module === true ? 'модуль на месте' : `модуля нет: ${payload.updater?.error ?? 'приложение не отчиталось'}`}, ${addressed}`,
  payload.updater?.module === true && !addressed.startsWith('адрес в сборке разошёлся'),
)

// 10. Ловит: нативный значок в menu bar, не доехавший до сборки. На macOS 26
//     `Tray` из Electron 43 в панель не встаёт вовсе, и значок рисует
//     отдельный процесс на Swift — то есть без этого файла установленное
//     приложение выглядит незапущенным, оставаясь работающим. Ловится три
//     поломки сразу: файл не попал в `extraResources`, он собран под одну
//     архитектуру из двух (dmg два, хелпер один), и он не запускается — а
//     запуск здесь настоящий, потому что «файл на месте» ничего не говорит о
//     том, стартует ли он.
if (process.platform !== 'darwin') {
  console.log('— 10. нативный значок menu bar: не macOS, хелпера в сборке нет намеренно')
} else {
  const helper = app === null ? null : join(app.resources, 'agentmeter-menubar')
  const present = helper !== null && existsSync(helper)
  const arches = present
    ? spawnSync('lipo', ['-archs', helper!], { encoding: 'utf8' }).stdout.trim()
    : ''
  // Хелпер живёт, пока открыт его stdin, и уходит, когда труба закрывается.
  // Поэтому запуск проверяется первой строкой в stdout: она приходит до любой
  // команды, а `input: ''` закрывает трубу сразу и не оставляет процесс жить.
  const started = present
    ? spawnSync(helper!, [], { encoding: 'utf8', input: '', timeout: 10_000 })
    : null
  const ready = started?.stdout?.includes('"t":"ready"') === true
  const universal = arches.includes('arm64') && arches.includes('x86_64')
  report(
    10,
    'нативный значок menu bar внутри сборки, universal и запускается',
    present
      ? `${arches || 'архитектуры не прочитаны'}, ${ready ? 'стартует' : 'не отчитался при запуске'}`
      : `нет файла ${helper ?? '—'}`,
    present && universal && ready,
  )
}

process.exit(failed ? 1 : 0)
