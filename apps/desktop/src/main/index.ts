/**
 * Main-процесс: попап из трея, главное окно, живые данные, проводка IPC.
 *
 * Сборка обычным `tsc`, без бандлера. Это не экономия: main работает с
 * `node:sqlite` и домашними каталогами пользователя, и стоит прогнать его через
 * бандлер — оба места придётся чинить настройками сборки. Из `dist/` он
 * запускается той нодой, что несёт Electron, без флагов вроде
 * `--experimental-strip-types`: в Electron их не передашь.
 *
 * Чего здесь намеренно нет: автообновления и меню — это M5.
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
  type NativeImage,
  type Rectangle,
} from 'electron'
import {
  claudeHome,
  codexHome,
  configPath,
  createLiveLayer,
  defaultIndexPath,
  ingestAll,
  ingestSteps,
  lifetimesPath,
  limitsReport,
  loadConfig,
  setLocale,
  t,
  openDb,
  watchSources,
  type Config,
  type Db,
  type IngestProgress as CoreIngestProgress,
  type LiveLayerOptions,
  type WindowBounds,
  type SourceIssue,
  type LiveLayer,
  type Watcher,
} from '@agentmeter/core'
import type {
  ConfigReport,
  DeepPartial,
  IndexProgress,
  IpcEventName,
  IpcEvents,
  TraySnapshot,
  WindowTab,
} from '@agentmeter/ipc'
import { configReport, setConfig } from './config.ts'
import { buildDayReport } from './day.ts'
import { buildTaskCard } from './task.ts'
import { registerIpc, type IpcHandlers } from './ipc.ts'
import { buildSnapshot } from './snapshot.ts'
import { levelFor, trayBitmap, type TrayState } from './tray-icon.ts'

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
 * Главное окно (3.1). Размер — из макета (строка 564); минимум подобран по
 * раскладке: правая колонка занимает 300 фиксированных точек, и ниже 900 лента
 * из пяти колонок начинает лезть друг на друга.
 *
 * Размер и положение не запоминаются, и это осознанно: хранить их негде, кроме
 * конфига, а конфиг — контракт 0.5, который правится ради нужды, а не ради
 * догадки о ней. Переезжает в 3.6 вместе с остальными настройками.
 */
const WINDOW_WIDTH = 1180
const WINDOW_HEIGHT = 740
const WINDOW_MIN_WIDTH = 900
const WINDOW_MIN_HEIGHT = 560
/**
 * Логический размер иконки трея. Растр рисуется ещё в двойном и тройном
 * размере: menu bar на retina берёт представление @2x, и без него иконка
 * растягивается из шестнадцати пикселей в мыло.
 */
const TRAY_SIZE = 16
const TRAY_SCALES = [1, 2, 3] as const
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
  /**
   * Настройки живого слоя — тот же объект, что держит сам слой (3.6). Смена
   * порогов правит его по месту, и новое значение работает со следующего
   * снимка; подмена объекта слою не видна, он захватил ссылку при создании.
   */
  liveOptions: LiveLayerOptions
  /** Замечания загрузчика: что в файле настроек не понято и заменено. */
  configProblems: string[]
  watcher?: Watcher
  /**
   * До чего не добрались на последнем обходе. Держится здесь, а не пересчитыва-
   * ется в снимке: обход каталогов на каждый опрос трея — это то, ради чего в
   * 2.1 выкидывали `ps`, только дороже.
   */
  issues: SourceIssue[]
  /** Ход первого прохода. `undefined` — индекс собран, экрана прогресса нет. */
  indexing?: IndexProgress | undefined
  /** Незавершённый первый проход: гоняется по кусочкам, чтобы окно рисовалось. */
  pending?: Generator<CoreIngestProgress, unknown> | undefined
  /** Когда начался отложенный проход — из него считается оставшееся время. */
  startedIngestAt?: number
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

/**
 * Открыть индекс и живой слой.
 *
 * `defer` откладывает первый проход: он идёт кусками уже после того, как окно
 * поднялось, и попап всё это время показывает экран индексирования (2.8).
 * Синхронный проход длиной в секунды держит однопоточный main целиком — окна
 * не будет вовсе, а не «окно с полосой».
 */
function openRuntime(withWatcher: boolean, defer = false): Runtime {
  const loaded = loadConfig(configPath())
  const config = loaded.config
  // Язык ставится до первой собранной строки: подсказка трея, оговорки точности
  // и фразы карточки собираются в main, и собраны они будут на том языке,
  // который стоит сейчас.
  setLocale(config.ui.locale)
  const { db } = openDb(defaultIndexPath())
  const sources = {
    claudeHome: claudeHome(config),
    codexHome: codexHome(config),
    extra: config.sources.extra,
    claudeLimits: config.limits.claude,
  }
  const ingested = defer ? undefined : ingestAll(db, sources)
  // Объект живёт дольше вызова: смена порогов в настройках правит его по месту,
  // и слой видит новое значение на следующем снимке (3.6).
  const liveOptions: LiveLayerOptions = {
    claudeHome: sources.claudeHome,
    codexHome: sources.codexHome,
    idleMs: config.live.idleMs,
    codexSilenceMs: config.live.codexSilenceMs,
    claudeLimits: config.limits.claude,
    // Журнал замера хвостовых прогревов (долг 1.3) ведёт только приложение:
    // оно одно видит и рождение, и смерть процесса.
    lifetimesPath: lifetimesPath(),
  }
  // Тот же объект, а не его копия: разложи его здесь через `...` — и правка
  // порогов в настройках меняла бы копию, до которой слою нет дела.
  const live = createLiveLayer(db, liveOptions)
  const runtime: Runtime = {
    db,
    live,
    config,
    liveOptions,
    configProblems: loaded.problems,
    issues: ingested?.issues ?? [],
  }
  if (defer) {
    runtime.pending = ingestSteps(db, { ...sources, progress: true })
    runtime.indexing = {
      phase: 'scanning',
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      etaMs: null,
    }
  }
  // При отложенном проходе вотчер поднимается после него: иначе первое же
  // событие файловой системы дёрнет второй полный `ingestAll` поверх текущего.
  if (withWatcher && !defer && config.index.watch) startWatcher(runtime)
  return runtime
}

/**
 * Поднять вотчер по текущему конфигу.
 *
 * Одна функция на три места (старт, конец отложенного прохода, включение
 * настройкой): разойдись они параметрами — наблюдатель после переключения
 * тумблера следил бы не за тем, за чем следил при запуске, и заметить это
 * можно было бы только по не обновляющимся цифрам.
 */
function startWatcher(runtime: Runtime): void {
  if (runtime.watcher !== undefined) return
  runtime.watcher = watchSources(runtime.db, {
    claudeHome: claudeHome(runtime.config),
    codexHome: codexHome(runtime.config),
    extra: runtime.config.sources.extra,
    claudeLimits: runtime.config.limits.claude,
    // Недоступный источник может появиться и исчезнуть на ходу: внешний диск
    // отмонтировали, права поправили. Снимок обязан догонять, а не помнить
    // первое впечатление.
    onBatch: (_paths, stats) => {
      runtime.issues = stats.issues
    },
  })
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
  let trayReport: unknown
  let windowReport: unknown
  let settingsReport: unknown
  try {
    snapshot = buildSnapshot(runtime.db, runtime.live, runtime.config, { issues: runtime.issues })
    registerIpc(
      ipcMain,
      // Главное окно смоук поднимает сам, ниже и явно: канал здесь заглушен,
      // чтобы проверка не зависела от того, нажал ли кто-то кнопку в попапе.
      createHandlers(
        () => runtime,
        () => undefined,
        (patch) => setConfig(runtime, patch),
      ),
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

    // Иконка трея (2.7). Растр проверяется юнит-тестами без Electron, а здесь
    // единственное, чего те увидеть не могут: что `nativeImage` этот буфер
    // принял, что представления @2x и @3x доехали и что на macOS иконка
    // объявлена template. Последнее — тихая ошибка: цветная иконка выглядит
    // рабочей и просто не переключается вместе с темой menu bar.
    const icon = trayIcon(trayState(snapshot, runtime.config))
    const size = icon.getSize()
    const scales = icon.getScaleFactors()
    trayReport = {
      size: `${size.width}×${size.height}`,
      scales,
      template: icon.isTemplateImage(),
      empty: icon.isEmpty(),
    }
    if (icon.isEmpty()) problems.push('иконка трея пустая')
    if (size.width !== TRAY_SIZE)
      problems.push(`иконка трея ${size.width} точек вместо ${TRAY_SIZE}`)
    if (scales.length !== TRAY_SCALES.length) {
      problems.push(`у иконки ${scales.length} представлений вместо ${TRAY_SCALES.length}`)
    }
    if (process.platform === 'darwin' && !icon.isTemplateImage()) {
      problems.push('иконка трея на macOS не template image')
    }

    // Главное окно (3.1). Юнит-тесты рендерят его компоненты в строку и о
    // существовании страницы не знают ничего: третий вход бандлера могли
    // забыть, `window.html` могло не доехать в сборку, вкладка из адреса могла
    // не читаться. Всё это оставляет `npm run check` зелёным, а кнопку
    // «Открыть окно» — мёртвой.
    const main = createMainWindow('settings', runtime.config.ui.window)
    main.webContents.on('preload-error', (_event, path, error) => {
      problems.push(`preload главного окна не загрузился (${path}): ${error.message}`)
    })
    main.webContents.on('did-fail-load', (_event, code, description) => {
      problems.push(`главное окно не загрузилось: ${description} (${code})`)
    })
    await new Promise<void>((resolve) => {
      main.webContents.once('did-finish-load', () => resolve())
      setTimeout(resolve, 15_000)
    })
    const openedTab = await main.webContents.executeJavaScript(
      'new URLSearchParams(location.search).get("tab")',
    )
    if (openedTab !== 'settings') {
      problems.push(`главное окно открылось с вкладкой ${String(openedTab)} вместо settings`)
    }
    windowReport = {
      page: new URL(main.webContents.getURL()).pathname.split('/').at(-1),
      tab: openedTab,
    }
    main.destroy()

    // Настройки (3.6) — только под `AGENTMETER_HOME`. Проверка пишет конфиг и
    // поднимает окно запомненного размера; без подменённого каталога она
    // затирала бы настройки того, кто её запустил.
    if (process.env['AGENTMETER_HOME']) {
      const wanted = { width: 1000, height: 640, x: 40, y: 40 }
      const written = setConfig(runtime, { ui: { theme: 'dark', window: wanted } })
      const fromDisk = loadConfig(configPath()).config
      const restored = createMainWindow('today', fromDisk.ui.window)
      await new Promise<void>((resolve) => {
        restored.webContents.once('did-finish-load', () => resolve())
        setTimeout(resolve, 15_000)
      })
      const bounds = restored.getNormalBounds()
      restored.destroy()
      settingsReport = {
        problems: written.problems,
        theme: fromDisk.ui.theme,
        wanted,
        bounds: { width: bounds.width, height: bounds.height },
        sources: written.sources.map((source) => source.provider),
      }
    }

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
      tray: trayReport,
      window: windowReport,
      settings: settingsReport,
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
function createHandlers(
  runtime: () => Runtime,
  openWindow: (tab: WindowTab) => void,
  changeConfig: (patch: DeepPartial<Config>) => ConfigReport,
): IpcHandlers {
  return {
    'snapshot:get': () =>
      withIndexing(
        runtime(),
        buildSnapshot(runtime().db, runtime().live, runtime().config, { issues: runtime().issues }),
      ),
    'limits:get': () =>
      limitsReport(runtime().db, Date.now(), runtime().config.limits.claude).windows,
    'config:get': () => configReport(runtime()),
    'today:get': (filter) => buildDayReport(runtime().db, filter, runtime().config.privacy),
    'task:get': (arg) => buildTaskCard(runtime().db, arg, runtime().config),
    'breakdown:get': () => [],
    'config:set': ({ patch }) => changeConfig(patch),
    'index:rebuild': () => undefined,
    'doctor:get': () => ({
      cliVersions: [],
      unknownRecordTypes: {},
      malformedLines: 0,
      problems: [],
    }),
    'window:open': ({ tab }) => {
      openWindow(tab)
    },
    'app:quit': () => {
      app.quit()
    },
  }
}

/**
 * Дописать в снимок ход первого прохода (2.8).
 *
 * Отдельной функцией, а не полем внутри `buildSnapshot`: тот собирает то, что
 * прочитано из индекса, а прогресс — состояние процесса, который в этот индекс
 * пишет. Смешать их значит завести в сборщике снимка знание о том, кто и когда
 * его вызвал.
 */
function withIndexing(runtime: Runtime, snapshot: TraySnapshot): TraySnapshot {
  if (runtime.indexing === undefined) return snapshot
  return { ...snapshot, indexing: runtime.indexing }
}

/**
 * Гнать отложенный проход кусками, отдавая цикл событий окну между ними.
 *
 * Кусок меряется временем, а не числом файлов: файлы различаются по размеру на
 * три порядка, и «двадцать файлов за раз» — это то миллисекунда, то полсекунды
 * с замершим окном.
 */
const INGEST_SLICE_MS = 60

function driveIngest(runtime: Runtime, onProgress: (progress: IndexProgress) => void): void {
  const pending = runtime.pending
  if (pending === undefined) return
  const started = Date.now()
  let done = false
  let last: CoreIngestProgress | undefined

  while (Date.now() - started < INGEST_SLICE_MS) {
    const step = pending.next()
    if (step.done) {
      done = true
      break
    }
    last = step.value
  }

  if (last !== undefined) {
    // Оставшееся время считается по уже пройденным байтам. Пока не пройдено
    // ничего, честнее `null`, чем бодрое «≈ 0 с»: попап такую оценку не рисует
    // вовсе.
    const elapsed = runtime.startedIngestAt === undefined ? 0 : Date.now() - runtime.startedIngestAt
    const etaMs =
      last.bytesDone > 0 && elapsed > 0
        ? Math.round((elapsed / last.bytesDone) * (last.bytesTotal - last.bytesDone))
        : null
    runtime.indexing = {
      phase: 'parsing',
      filesDone: last.filesDone,
      filesTotal: last.filesTotal,
      bytesDone: last.bytesDone,
      bytesTotal: last.bytesTotal,
      etaMs,
    }
    onProgress(runtime.indexing)
  }

  if (done) {
    runtime.pending = undefined
    runtime.indexing = undefined
    if (runtime.config.index.watch) startWatcher(runtime)
    return
  }
  setImmediate(() => {
    driveIngest(runtime, onProgress)
  })
}

/**
 * Иконка трея из состояния (2.7). Рисование — в `tray-icon.ts`, здесь только
 * упаковка в `nativeImage` и один платформенный выбор.
 *
 * На macOS иконка обязана быть template image: система красит её сама под тему
 * menu bar и под выделение. Ошибка здесь тихая — цветная иконка выглядит
 * рабочей и просто не переключается вместе с темой, а на тёмной панели
 * оказывается тёмной.
 */
function trayIcon(state: TrayState): NativeImage {
  const template = process.platform === 'darwin'
  const base = trayBitmap(state, TRAY_SIZE, template)
  const image = nativeImage.createFromBitmap(base.data, {
    width: base.width,
    height: base.height,
    scaleFactor: 1,
  })
  for (const scale of TRAY_SCALES) {
    if (scale === 1) continue
    const rep = trayBitmap(state, TRAY_SIZE * scale, template)
    image.addRepresentation({
      scaleFactor: scale,
      width: rep.width,
      height: rep.height,
      buffer: rep.data,
    })
  }
  if (template) image.setTemplateImage(true)
  return image
}

/**
 * Что показывает иконка: работающие агенты и ближайший к потолку процент.
 *
 * Завершившиеся не в счёт. Они висят в снимке ещё `doneGraceMs` ради гашеной
 * строки в попапе, но столбик в трее — это «работает прямо сейчас», и держать
 * его пять минут после смерти процесса значит врать самой заметной частью
 * интерфейса. Порядок столбиков — по расходу, чтобы первый был самым дорогим;
 * высоты при этом остаются ритмом макета, а не величиной.
 */
function trayState(snapshot: TraySnapshot, config: Config): TrayState {
  const working = snapshot.agents
    .filter((agent) => agent.state !== 'done')
    .sort((a, b) => b.tokens - a.tokens)
  const state: TrayState = {
    agents: working.map((agent) => agent.provider),
    warnAt: config.alerts.warnAtPercent,
    dangerAt: config.alerts.dangerAtPercent,
  }
  if (snapshot.nearestLimitPercent !== undefined) {
    state.limitPercent = snapshot.nearestLimitPercent
  }
  return state
}

/**
 * Подпись под курсором. Здесь и живёт то, чего иконка сказать не может:
 * сколько именно агентов, когда их больше трёх, и какой процент нарисован
 * полосой. Незнание названо словами — у Claude процента нет до калибровки 1.9,
 * и «лимит 0%» было бы неправдой.
 */
function trayTooltip(state: TrayState): string {
  const count = state.agents.length
  // Своих правил счёта здесь больше нет: формы лежат в каталоге, и «5 агента»
  // на одиннадцати агентах теперь невозможно — этим занимается `Intl`.
  const agents = count === 0 ? t('popup.nobody') : t('popup.agents', { count })
  const limit =
    state.limitPercent === undefined
      ? t('limit.unknown')
      : t('limit.trayPercent', { percent: Math.round(state.limitPercent) })
  return `Agentmeter · ${agents} · ${limit}`
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
 * Главное окно (3.1). Рамка обычная, от операционной системы.
 *
 * Три цветных кружка в строке 567 макета — это её кнопки, нарисованные
 * дизайнером для контекста, а не наш элемент: своя копия «закрыть» — самый
 * заметный способ сделать приложение похожим на веб-страницу, и вдобавок она
 * ломается на каждой платформе по-своему. Наша шапка в 44 точки живёт под
 * системной.
 *
 * Вкладка едет параметром адреса, а не событием: окно только что создано, и
 * канала, по которому спросить «на какой вкладке открылось», у него ещё нет.
 */
function createMainWindow(tab: WindowTab, remembered: WindowBounds): BrowserWindow {
  const bounds = usableBounds(remembered)
  const window = new BrowserWindow({
    width: bounds?.width ?? WINDOW_WIDTH,
    height: bounds?.height ?? WINDOW_HEIGHT,
    ...(bounds?.x === undefined ? {} : { x: bounds.x, y: bounds.y }),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: 'Agentmeter',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void window.loadFile(`${WEB}/window.html`, { query: { tab } })
  return window
}

/**
 * Годится ли запомненная геометрия сегодня (3.6).
 *
 * Экран, на котором окно стояло вчера, мог отвалиться вместе с докой, и
 * восстановленное окно оказалось бы за краем видимой области — то есть
 * пропало бы совсем, без единого сообщения. Поэтому позиция принимается,
 * только если прямоугольник **пересекается** с рабочей областью хоть одного
 * дисплея; нулевая ширина означает «не запомнено».
 */
function usableBounds(
  bounds: WindowBounds,
): { width: number; height: number; x?: number; y?: number } | null {
  if (bounds.width < WINDOW_MIN_WIDTH || bounds.height < WINDOW_MIN_HEIGHT) return null
  const size = { width: bounds.width, height: bounds.height }
  const fits = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
  // Размер переживает пропажу экрана, позиция — нет: без неё окно откроется по
  // центру, а с ней — за краем видимой области, то есть нигде.
  return fits ? { ...size, x: bounds.x, y: bounds.y } : size
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
  //
  // Витрины это не касается, и её пришлось выносить из-под замка отдельной
  // строкой: она рисует фикстуры, в индекс не смотрит вовсе и трея не заводит,
  // а под общим правилом просто не открывалась, пока приложение висит в трее —
  // молча, потому что `app.quit()` до создания окна выглядит как удачный выход.
  // То есть единственный способ посмотреть вёрстку не работал ровно тогда, когда
  // приложением пользуются.
  if (!gallery && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let runtime: Runtime | undefined
  let window: BrowserWindow | undefined
  let main: BrowserWindow | undefined
  let tray: Tray | undefined
  let timer: NodeJS.Timeout | undefined
  let tick = 0
  // Прошлое состояние иконки. Перерисовывать её раз в секунду незачем: растр
  // меняется только когда меняется число агентов или уровень тревоги, а
  // `setImage` на каждый опрос — это мигание в menu bar на ровном месте.
  let painted = ''

  const visible = (): boolean => window !== undefined && !window.isDestroyed() && window.isVisible()

  /**
   * Кому сейчас есть смысл слать снимок.
   *
   * Попап — только пока он виден: он висит в трее и большую часть суток скрыт.
   * Главное окно — пока оно существует: свёрнутое окно человек разворачивает
   * мгновенно, и застать в нём цифры минутной давности хуже, чем лишний
   * `send` раз в секунду.
   */
  const listeners = (): BrowserWindow[] => {
    const targets: BrowserWindow[] = []
    if (visible()) targets.push(window!)
    if (main !== undefined && !main.isDestroyed()) targets.push(main)
    return targets
  }

  const emit = <K extends IpcEventName>(channel: K, payload: IpcEvents[K]): void => {
    for (const target of listeners()) target.webContents.send(channel, payload)
  }

  /**
   * Открыть главное окно или показать уже открытое.
   *
   * Второго такого окна не бывает: два окна на одну базу — это два вотчера и
   * два счёта одного расхода на глазах у человека, ровно то, от чего стоит
   * `requestSingleInstanceLock`. Вкладку у открытого окна не переключаем —
   * перезагрузка ради неё стёрла бы прокрутку, фильтр и раскрытую задачу.
   */
  const openMainWindow = (tab: WindowTab): void => {
    if (main !== undefined && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
      return
    }
    main = createMainWindow(tab, runtime!.config.ui.window)
    main.once('ready-to-show', () => {
      main?.show()
      main?.focus()
      // Снимок сразу, не дожидаясь следующего опроса: иначе шапка окна секунду
      // стоит пустой, и это выглядит как «лимит неизвестен».
      if (runtime !== undefined) main?.webContents.send('live:update', snapshot())
    })
    // Геометрия запоминается при закрытии, а не на каждое движение мыши:
    // писать конфиг двадцать раз в секунду ради «окно поехало вправо» —
    // это износ диска и гонка с правкой файла руками.
    main.on('close', () => {
      if (runtime === undefined || main === undefined || main.isDestroyed()) return
      const { width, height, x, y } = main.getNormalBounds()
      changeConfig({ ui: { window: { width, height, x, y } } })
    })
    main.on('closed', () => {
      main = undefined
      // Иконка в доке нужна ровно пока есть окно: приложение живёт в трее.
      if (process.platform === 'darwin' && !windowed) app.dock?.hide()
    })
    if (process.platform === 'darwin') void app.dock?.show()
  }

  const snapshot = (): TraySnapshot =>
    withIndexing(
      runtime!,
      buildSnapshot(runtime!.db, runtime!.live, runtime!.config, { issues: runtime!.issues }),
    )

  const poll = (): void => {
    tick += 1
    const shown = listeners().length > 0
    if (!shown && tick % HIDDEN_POLL_FACTOR !== 0) return
    // При закрытом попапе снимок всё равно снимается, только вшестеро реже.
    // Не ради рисования: журнал времени жизни (долг 1.3) видит смерть процесса
    // только тогда, когда кто-то посмотрел, и перестань мы смотреть — вместо
    // наблюдения останется «не знаем», а это единственные данные проекта,
    // которые задним числом не восстановить.
    const current = snapshot()
    paintTray(current)
    if (shown) emit('live:update', current)
  }

  const paintTray = (current: TraySnapshot): void => {
    if (tray === undefined || tray.isDestroyed()) return
    const state = trayState(current, runtime!.config)
    // Отпечаток — ровно то, что видно на иконке. Процент округляется до целого:
    // полоса в 16 точек дробей не показывает, а перерисовка на каждый десятый
    // процента — это та же лишняя работа, только незаметная.
    const key = `${state.agents.join(',')}|${levelFor(state)}|${
      state.limitPercent === undefined ? '—' : Math.round(state.limitPercent)
    }`
    if (key === painted) return
    painted = key
    tray.setImage(trayIcon(state))
    tray.setToolTip(trayTooltip(state))
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

  /**
   * Правка настроек: записать, применить, разослать (3.6).
   *
   * Здесь живёт та часть применения, которой нужны таймер, вотчер и Electron;
   * всё остальное делает `main/config.ts`. Событие уходит **после** применения
   * и всем окнам сразу, включая то, которое правку прислало: главное окно и
   * попап показывают одни и те же настройки, и разъехаться языку в двух окнах
   * одного приложения нельзя.
   */
  const changeConfig = (patch: DeepPartial<Config>): ConfigReport => {
    const current = runtime!.config
    const wasPollMs = current.live.pollMs
    const wasWatching = current.index.watch
    const report = setConfig(runtime!, patch)
    const next = runtime!.config
    nativeTheme.themeSource = next.ui.theme
    if (next.live.pollMs !== wasPollMs) {
      if (timer) clearInterval(timer)
      timer = setInterval(poll, next.live.pollMs)
    }
    if (next.index.watch !== wasWatching) {
      if (next.index.watch) startWatcher(runtime!)
      else {
        runtime!.watcher?.close()
        delete runtime!.watcher
      }
    }
    emit('config:changed', report)
    return report
  }

  void app.whenReady().then(() => {
    // Витрина — лист образцов на фикстурах: ни индекса, ни вотчера, ни трея.
    // Открывать ей базу нельзя вдвойне: она запускается **поверх** работающего
    // приложения, и второй проход по тем же файлам той же базы — это ровно то
    // удвоение, ради которого заведён замок.
    if (gallery) {
      window = createPopup('gallery', false)
      window.once('ready-to-show', () => {
        window?.show()
      })
      return
    }

    runtime = openRuntime(true, true)
    runtime.startedIngestAt = Date.now()
    // Тема окна следует конфигу: при `system` Electron сам отдаёт рендереру
    // системный `prefers-color-scheme`, поэтому отдельного канала темы не нужно
    // и переключение работает без перезапуска.
    nativeTheme.themeSource = runtime.config.ui.theme

    registerIpc(
      ipcMain,
      createHandlers(() => runtime!, openMainWindow, changeConfig),
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
      const first = snapshot()
      tray = new Tray(trayIcon(trayState(first, runtime.config)))
      tray.setToolTip(trayTooltip(trayState(first, runtime.config)))
      tray.on('click', toggle)
      // На macOS иконка в доке приложению без окон не нужна.
      if (process.platform === 'darwin') app.dock?.hide()
    }

    driveIngest(runtime, (progress) => {
      emit('index:progress', progress)
      if (listeners().length > 0) emit('live:update', snapshot())
    })

    timer = setInterval(poll, runtime.config.live.pollMs)
  })

  app.on('window-all-closed', () => {
    // Попап живёт в трее: закрытое окно — это норма, а не выход из приложения.
    // Закрытое главное окно — тем более: приложение продолжает считать.
    if (windowed) app.quit()
  })

  app.on('before-quit', () => {
    if (timer) clearInterval(timer)
    tray?.destroy()
    if (runtime) closeRuntime(runtime)
  })
}

main()
