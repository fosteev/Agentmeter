/**
 * Смоук собранного приложения.
 *
 *     npm run -w @agentmeter/desktop build
 *     node --experimental-strip-types scripts/probe/desktop-smoke.ts
 *
 * Единственная проверка, доказывающая, что Electron вообще живой и `node:sqlite`
 * в нём работает. Зелёный `npm run check` про приложение не говорит ничего: там
 * ни одного запуска Electron нет.
 *
 * Пять проверок, каждая названа по поломке, которую обязана поймать.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const desktop = join(root, 'apps/desktop')
const mainJs = join(desktop, 'dist/main/index.js')
const preloadCjs = join(desktop, 'dist/preload/index.cjs')

let failed = false

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}

function newestUnder(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestUnder(path) : statSync(path).mtimeMs)
  }
  return newest
}

function runElectron(extraEnv: Record<string, string>): {
  status: number | null
  stdout: string
  stderr: string
} {
  const electron = require('electron') as string
  const env = { ...process.env, ...extraEnv }
  if (extraEnv['ELECTRON_RUN_AS_NODE'] === undefined) delete env['ELECTRON_RUN_AS_NODE']
  const result = spawnSync(electron, [desktop, '--smoke'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// 1. Ловит: приложение, которое не собрано или собрано наполовину. Смоук обязан
//    запускать `dist/`, а не исходники: пробы и CLI ходят нодой с `--experimental-
//    strip-types`, а в Electron этот флаг не передашь, и «работает у меня» ничего
//    не значит.
const built = existsSync(mainJs) && existsSync(preloadCjs)
report(
  1,
  'собранное приложение на месте',
  built ? 'dist/main/index.js и dist/preload/index.cjs' : `нет ${mainJs} либо ${preloadCjs}`,
  built,
)

// 2. Ловит: проверку, запущенную на позавчерашней сборке. Исходник новее
//    собранного значит, что смоук доказывает работу кода, которого уже нет.
const newestSource = Math.max(
  newestUnder(join(desktop, 'src')),
  newestUnder(join(root, 'packages/core/src')),
  newestUnder(join(root, 'packages/ipc/src')),
)
// Не по `dist/main/index.js`: сборка инкрементальная, и правка соседнего модуля
// не трогает этот файл. Сравнивается самый свежий артефакт со самым свежим
// исходником.
const builtAt = built ? newestUnder(join(desktop, 'dist')) : 0
report(
  2,
  'сборка не отстала от исходников',
  built
    ? `dist на ${Math.round((builtAt - newestSource) / 1000)} с новее самого свежего исходника`
    : 'сборки нет',
  built && builtAt >= newestSource,
)

const run = built ? runElectron({}) : { status: 1, stdout: '', stderr: 'сборки нет' }
let payload: {
  electron?: string
  node?: string
  chrome?: string
  problems?: string[]
  snapshot?: { at?: number; today?: { total?: { value?: number } }; limits?: unknown[] }
} = {}
try {
  payload = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}')
} catch {
  payload = {}
}

// 3. Ловит: приложение, которое не стартует или стартует наполовину — сломанный
//    ESM-вход, упавшее открытие индекса, а главное — окно без моста. Смоук
//    поднимает скрытое окно и спрашивает у рендерера, доехал ли `window.agentmeter`:
//    путь к preload, склеенный строкой с `..`, роняет ровно это, оставляя окно
//    живым и пустым.
report(
  3,
  'приложение запустилось, окно поднялось с мостом',
  run.status === 0
    ? 'exit=0, проблем нет'
    : `exit=${run.status}; ${(payload.problems ?? []).join(' · ') || run.stderr.trim().slice(0, 300)}`,
  run.status === 0,
)

// 4. Ловит: смоук, отработавший обычной нодой. `node:sqlite` есть и в ней, снимок
//    соберётся, код выхода будет 0 — и «доказательство работы Electron» окажется
//    доказательством работы ноды. Отсюда же требование к самому смоуку: он
//    проверяет `process.versions.electron` до всего остального.
const genuine = Boolean(payload.electron) && Boolean(payload.chrome)
report(
  4,
  'это настоящий main-процесс Electron',
  genuine
    ? `electron ${payload.electron}, node ${payload.node}, chrome ${payload.chrome}`
    : 'в выводе нет версий Electron и Chrome',
  genuine,
)

// 5. Ловит: `node:sqlite`, который в Electron не завёлся, и вообще любую поломку
//    пути «индекс → живой слой → TraySnapshot». Снимок обязан быть собран
//    настоящий, а не пустой заглушкой.
const snapshot = payload.snapshot
const hasSnapshot =
  snapshot !== undefined &&
  typeof snapshot.at === 'number' &&
  typeof snapshot.today?.total?.value === 'number' &&
  Array.isArray(snapshot.limits)
report(
  5,
  'node:sqlite в main живой и снимок собран',
  hasSnapshot
    ? `at=${snapshot.at}, сумма за сутки=${snapshot.today?.total?.value}, окон=${snapshot.limits?.length}`
    : 'снимок не собран',
  hasSnapshot,
)

// 6. Ловит: смоук, который зеленеет там, где Electron подменён нодой. Проверка
//    обратная четвёртой и нужна отдельно: четвёртая ловит подмену по факту, эта —
//    доказывает, что сам смоук умеет её замечать.
const asNode = built
  ? runElectron({ ELECTRON_RUN_AS_NODE: '1' })
  : { status: 0, stdout: '', stderr: '' }
report(
  6,
  'под ELECTRON_RUN_AS_NODE смоук падает',
  asNode.status === 0
    ? 'вышел нулём, то есть проверка подлинности не работает'
    : `exit=${asNode.status}`,
  asNode.status !== 0,
)

process.exit(failed ? 1 : 0)
