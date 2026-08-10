/**
 * Main-процесс: окно попапа, заглушка трея, живые данные, проводка IPC.
 *
 * Сборка обычным `tsc`, без бандлера. Это не экономия: main работает с
 * `node:sqlite` и домашними каталогами пользователя, и стоит прогнать его через
 * бандлер — оба места придётся чинить настройками сборки. Из `dist/` он
 * запускается той нодой, что несёт Electron, без флагов вроде
 * `--experimental-strip-types`: в Electron их не передашь.
 *
 * Чего здесь намеренно нет: автообновления, меню, вторых окон, настроек и
 * пяти состояний иконки трея. Это M3, M5 и этап 2.7.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrowserWindow,
  Tray,
  app,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  type Rectangle,
} from 'electron'
import {
  claudeHome,
  codexHome,
  configPath,
  createLiveLayer,
  defaultIndexPath,
  ingestAll,
  lifetimesPath,
  limitsReport,
  loadConfig,
  openDb,
  watchSources,
  type Config,
  type Db,
  type LiveLayer,
  type Watcher,
} from '@agentmeter/core'
import type { IpcEventName, IpcEvents, TraySnapshot } from '@agentmeter/ipc'
import { registerIpc, type IpcHandlers } from './ipc.ts'
import { buildSnapshot } from './snapshot.ts'

const here = fileURLToPath(new URL('./', import.meta.url))
/**
 * Пути нормализуются, а не склеиваются строкой.
 *
 * `dist/main/../preload/index.cjs` существует с точки зрения `fs`, но загрузчик
 * preload у Electron такой путь не открывает и падает с ENOENT — окно при этом
 * поднимается, рендерер грузится, и только моста в нём нет. Смоук, не
 * открывающий окна, этого не видит вовсе.
 */
const WEB = join(here, '../web')
const PRELOAD = join(here, '../preload/index.cjs')

const POPUP_WIDTH = 400
const POPUP_HEIGHT = 600
/**
 * Во сколько раз реже опрашивать при закрытом попапе. Число живёт здесь, а не в
 * конфиге: пока никто не просил его крутить, настройка была бы догадкой о
 * потребности. `live.pollMs` трогать нельзя — на нём держится критерий 2.1
 * «новая сессия видна меньше чем за 2 с».
 */
const HIDDEN_POLL_FACTOR = 5

interface Runtime {
  db: Db
  live: LiveLayer
  config: Config
  watcher?: Watcher
}

/**
 * Проверка подлинности процесса — первое, что делает приложение.
 *
 * В среде разработчика бывает выставлена `ELECTRON_RUN_AS_NODE=1` (её наследуют
 * терминалы внутри VS Code), и тогда бинарник Electron стартует обычной нодой:
 * `require('electron')` отдаёт строку с путём, `app` равен `undefined`.
 * Опасно здесь не падение, а зелёный результат: `node:sqlite` есть и в простой
 * ноде, снимок соберётся, код выхода будет 0 — и смоук «докажет» работу
 * Electron, ничего не проверив.
 */
function assertElectron(): void {
  if (!process.versions.electron || typeof app !== 'object' || app === null) {
    throw new Error(
      'это не main-процесс Electron: снимите ELECTRON_RUN_AS_NODE и запускайте бинарником electron',
    )
  }
}

function openRuntime(withWatcher: boolean): Runtime {
  const loaded = loadConfig(configPath())
  const config = loaded.config
  const { db } = openDb(defaultIndexPath())
  const sources = {
    claudeHome: claudeHome(config),
    codexHome: codexHome(config),
    extra: config.sources.extra,
    claudeLimits: config.limits.claude,
  }
  ingestAll(db, sources)
  const live = createLiveLayer(db, {
    claudeHome: sources.claudeHome,
    codexHome: sources.codexHome,
    idleMs: config.live.idleMs,
    codexSilenceMs: config.live.codexSilenceMs,
    claudeLimits: config.limits.claude,
    // Журнал замера хвостовых прогревов (долг 1.3) ведёт только приложение:
    // оно одно видит и рождение, и смерть процесса.
    lifetimesPath: lifetimesPath(),
  })
  const runtime: Runtime = { db, live, config }
  if (withWatcher && config.index.watch) runtime.watcher = watchSources(db, sources)
  return runtime
}

function closeRuntime(runtime: Runtime): void {
  runtime.watcher?.close()
  runtime.live.flush()
  runtime.db.close()
}

/**
 * Смоук: единственная проверка, доказывающая, что Electron живой, `node:sqlite`
 * в нём работает, а окно поднимается вместе с мостом.
 *
 * Окно здесь открывается скрытым и это не роскошь. Первая же ошибка этапа была
 * ровно такой: путь к preload склеился строкой с `..` внутри, Electron его не
 * открыл, окно поднялось, рендерер загрузился — и остался без единого канала.
 * Смоук, который «просто собрал снимок», такое пропускает целиком.
 */
async function runSmoke(): Promise<void> {
  assertElectron()
  const runtime = openRuntime(false)
  const problems: string[] = []
  let snapshot: TraySnapshot | undefined
  try {
    snapshot = buildSnapshot(runtime.db, runtime.live, runtime.config)
    registerIpc(
      ipcMain,
      createHandlers(() => runtime),
    )

    const window = createPopup('index', true)
    window.webContents.on('preload-error', (_event, path, error) => {
      problems.push(`preload не загрузился (${path}): ${error.message}`)
    })
    window.webContents.on('did-fail-load', (_event, code, description) => {
      problems.push(`страница не загрузилась: ${description} (${code})`)
    })
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') problems.push(`ошибка в окне: ${details.message}`)
    })

    await new Promise<void>((resolve) => {
      window.webContents.once('did-finish-load', () => resolve())
      setTimeout(resolve, 15_000)
    })
    // Мост появляется в окне после preload; спрашиваем сам рендерер, а не себя.
    const bridge = await window.webContents.executeJavaScript(
      'typeof window.agentmeter === "object" && typeof window.agentmeter["snapshot:get"] === "function"',
    )
    if (bridge !== true) problems.push('в окне нет моста window.agentmeter')
    window.destroy()
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  } finally {
    closeRuntime(runtime)
  }

  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      problems,
      snapshot,
    }),
  )
  app.exit(problems.length === 0 ? 0 : 1)
}

/**
 * Обработчики каналов. Один набор на попап и на смоук: смоук поднимает то же
 * окно, и разойдись они — он проверял бы не то приложение, которое запускается.
 *
 * Заглушки честные: обработчик есть у каждого канала контракта и отдаёт пустой
 * результат нужного типа. Данные для них появятся в M3, а незарегистрированный
 * канал давал бы в окне повисший `invoke` без ответа и без ошибки.
 */
function createHandlers(runtime: () => Runtime): IpcHandlers {
  return {
    'snapshot:get': () => buildSnapshot(runtime().db, runtime().live, runtime().config),
    'limits:get': () =>
      limitsReport(runtime().db, Date.now(), runtime().config.limits.claude).windows,
    'config:get': () => ({ config: runtime().config, problems: [] }),
    'today:list': () => [],
    'task:get': () => null,
    'breakdown:get': () => [],
    'config:set': () => ({ problems: [] }),
    'index:rebuild': () => undefined,
    'doctor:get': () => ({
      cliVersions: [],
      unknownRecordTypes: {},
      malformedLines: 0,
      problems: [],
    }),
    'window:open': () => undefined,
    'app:quit': () => {
      app.quit()
    },
  }
}

function trayIcon() {
  // Временный квадрат 16×16 цвета `--claude`. Пять состояний, template image
  // для macOS и цветная для Windows — этап 2.7; попапу нужно лишь откуда
  // открываться. Буфер сырой, BGRA.
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)
  for (let index = 0; index < size * size; index += 1) {
    buffer[index * 4] = 0x3c
    buffer[index * 4 + 1] = 0x9e
    buffer[index * 4 + 2] = 0xe0
    buffer[index * 4 + 3] = 0xff
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
}

function createPopup(page: 'index' | 'gallery', frameless: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: page === 'gallery' ? 1280 : POPUP_WIDTH,
    height: page === 'gallery' ? 900 : POPUP_HEIGHT,
    show: false,
    frame: !frameless,
    resizable: page === 'gallery',
    skipTaskbar: frameless,
    // Белая вспышка на тёмной теме видна ровно один раз — при каждом открытии
    // попапа, то есть по десять раз на дню.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void window.loadFile(`${WEB}/${page}.html`)
  return window
}

/**
 * Попап под иконкой трея. Различие между платформами ровно одно: на macOS окно
 * висит под menu bar, на Windows и Linux прижимается к трею в углу рабочей
 * области. Раскладка при этом одна — дублировать её под платформу нельзя.
 */
function positionPopup(window: BrowserWindow, trayBounds: Rectangle | undefined): void {
  const size = window.getBounds()
  const anchor = trayBounds && trayBounds.width > 0 ? trayBounds : undefined
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea

  let x: number
  let y: number
  if (process.platform === 'darwin' && anchor) {
    x = Math.round(anchor.x + anchor.width / 2 - size.width / 2)
    y = Math.round(anchor.y + anchor.height + 4)
  } else if (anchor) {
    x = Math.round(anchor.x + anchor.width / 2 - size.width / 2)
    y = Math.round(
      anchor.y > area.y + area.height / 2
        ? anchor.y - size.height - 4
        : anchor.y + anchor.height + 4,
    )
  } else {
    x = area.x + area.width - size.width - 8
    y = area.y + area.height - size.height - 8
  }

  const clampedX = Math.min(Math.max(x, area.x + 8), area.x + area.width - size.width - 8)
  const clampedY = Math.min(Math.max(y, area.y + 8), area.y + area.height - size.height - 8)
  window.setPosition(clampedX, clampedY, false)
}

function main(): void {
  assertElectron()

  const argv = new Set(process.argv.slice(1))
  if (argv.has('--smoke')) {
    void app.whenReady().then(runSmoke)
    return
  }

  const gallery = argv.has('--gallery')
  const windowed = gallery || argv.has('--dev')

  // Второй экземпляр открыл бы вторую базу тем же файлом и второй вотчер на те
  // же каталоги: расход считался бы дважды на глазах у пользователя.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let runtime: Runtime | undefined
  let window: BrowserWindow | undefined
  let tray: Tray | undefined
  let timer: NodeJS.Timeout | undefined
  let tick = 0

  const visible = (): boolean => window !== undefined && !window.isDestroyed() && window.isVisible()

  const emit = <K extends IpcEventName>(channel: K, payload: IpcEvents[K]): void => {
    if (!visible()) return
    window?.webContents.send(channel, payload)
  }

  const snapshot = (): TraySnapshot => buildSnapshot(runtime!.db, runtime!.live, runtime!.config)

  const poll = (): void => {
    tick += 1
    const shown = visible()
    if (!shown && tick % HIDDEN_POLL_FACTOR !== 0) return
    // При закрытом попапе снимок всё равно снимается, только вшестеро реже.
    // Не ради рисования: журнал времени жизни (долг 1.3) видит смерть процесса
    // только тогда, когда кто-то посмотрел, и перестань мы смотреть — вместо
    // наблюдения останется «не знаем», а это единственные данные проекта,
    // которые задним числом не восстановить.
    const current = snapshot()
    if (shown) emit('live:update', current)
  }

  const toggle = (): void => {
    if (window === undefined || window.isDestroyed()) return
    if (window.isVisible()) {
      window.hide()
      return
    }
    positionPopup(window, tray?.getBounds())
    emit('live:update', snapshot())
    window.show()
    window.focus()
  }

  void app.whenReady().then(() => {
    runtime = openRuntime(true)
    // Тема окна следует конфигу: при `system` Electron сам отдаёт рендереру
    // системный `prefers-color-scheme`, поэтому отдельного канала темы не нужно
    // и переключение работает без перезапуска.
    nativeTheme.themeSource = runtime.config.ui.theme

    registerIpc(
      ipcMain,
      createHandlers(() => runtime!),
    )

    window = createPopup(gallery ? 'gallery' : 'index', !windowed)
    window.once('ready-to-show', () => {
      if (windowed) window?.show()
    })
    if (!windowed) {
      window.on('blur', () => {
        window?.hide()
      })
    }

    if (!gallery) {
      tray = new Tray(trayIcon())
      tray.setToolTip('Agentmeter')
      tray.on('click', toggle)
      // На macOS иконка в доке приложению без окон не нужна.
      if (process.platform === 'darwin') app.dock?.hide()
    }

    timer = setInterval(poll, runtime.config.live.pollMs)
  })

  app.on('window-all-closed', () => {
    // Попап живёт в трее: закрытое окно — это норма, а не выход из приложения.
    if (windowed) app.quit()
  })

  app.on('before-quit', () => {
    if (timer) clearInterval(timer)
    tray?.destroy()
    if (runtime) closeRuntime(runtime)
  })
}

main()
