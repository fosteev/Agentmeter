/**
 * Main-процесс: попап из трея, главное окно, живые данные, проводка IPC.
 *
 * Сборка обычным `tsc`, без бандлера. Это не экономия: main работает с
 * `node:sqlite` и домашними каталогами пользователя, и стоит прогнать его через
 * бандлер — оба места придётся чинить настройками сборки. Из `dist/` он
 * запускается той нодой, что несёт Electron, без флагов вроде
 * `--experimental-strip-types`: в Electron их не передашь.
 *
 * Чего здесь намеренно нет: автообновления — это M5. Меню трея появилось в 4.8
 * и состоит из одного пункта: выгрузки расхода в файл.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
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
  dayRange,
  LIVE_URGENCY,
  exportRows,
  toCsv,
  type Calibration,
  type Config,
  type Db,
  type UsageSnapshot,
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
import { configReport, setConfig, setOauth, setStartup, setStatusline } from './config.ts'
import { buildSpendScreen } from './breakdown.ts'
import { buildDayReport } from './day.ts'
import { buildHistoryScreen } from './history.ts'
import { buildTaskCard } from './task.ts'
import { registerIpc, type IpcHandlers } from './ipc.ts'
import { emptyNotifyState, planNotifications, type Notice } from './notify.ts'
import { buildSnapshot } from './snapshot.ts'
import { levelFor, trayBitmap, type TrayState } from './tray-icon.ts'
import { barBinaryPath, startNativeBar, type NativeBar } from './menubar.ts'
import { readStartup, type StartupHost } from './startup.ts'
import {
  drainSnapshot,
  openJournal,
  recalibrate,
  refreshHook,
  type StatuslineHost,
  type UsageJournal,
} from './statusline.ts'
import { openOauth, pollOauth, type OauthHost, type OauthState } from './oauth.ts'
import type { AppUpdater } from 'electron-updater'
import {
  applyAuto,
  initialUpdateState,
  mayCheck,
  nextUpdateState,
  type UpdateEvent,
  type UpdateState,
} from './update.ts'

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
/**
 * Потолок высоты попапа — 600 из макета. Не сама высота: окно подгоняется под
 * содержимое (`popup:resize`), и до потолка дорастает только длинный список
 * агентов. Зашитые 600 при коротком содержимом давали пустое поле внизу, а
 * рамка в один пиксель поверх них не влезала в окно — и скролл появлялся у
 * самого окна, поверх интерфейса, который прокручивать нечего.
 */
const POPUP_MAX_HEIGHT = 600
/**
 * Пол высоты попапа. Шапка с подвалом занимают ~100 точек, и окно ниже этого
 * означает не «мало содержимого», а «рендерер ещё не нарисовал» — такую высоту
 * ставить нельзя, иначе попап моргнёт полоской на первом кадре.
 */
const POPUP_MIN_HEIGHT = 160
/** Зазор до края рабочей области: попап у края экрана обрезался бы молча. */
const POPUP_MARGIN = 8
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
/**
 * Когда проверять обновления (5.4).
 *
 * Задержка первой проверки — чтобы не лезть в сеть посреди первого прохода
 * индекса. Шесть часов между следующими: приложение живёт в трее неделями, и
 * проверка только при запуске у такого означала бы «никогда».
 */
const UPDATE_FIRST_DELAY_MS = 30_000
const UPDATE_EVERY_MS = 6 * 3_600_000
/**
 * Сколько после готовности не считать `activate` кликом человека.
 *
 * Событие приходит и от самого запуска, и от клика по значку в доке, а отличить
 * их Electron не даёт. Три секунды с запасом перекрывают запуск и заведомо
 * меньше паузы между «приложение поднялось» и «человек до него добрался».
 */
const ACTIVATE_GRACE_MS = 3_000
/**
 * Как часто пересчитывать вес чтения кэша по журналу строки состояния (1.9).
 *
 * Не на каждый снимок: калибровка читает запросы Claude за все дни, покрытые
 * журналом, и на опросе раз в секунду это был бы полный проход по индексу
 * шестьдесят раз в минуту. Пять минут против журнала, который копится днями, —
 * задержка, которой не видно.
 */
const CALIBRATE_EVERY_MS = 5 * 60_000

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
  /** Чем спрашивать систему про автозапуск (5.3) — три метода `app`, не больше. */
  startup: StartupHost
  /** Ход обновления (5.4). Живёт в памяти: перезапуск начинает проверку заново. */
  update: UpdateState
  /** Куда ставится хук строки состояния и где лежит его журнал (1.9). */
  statusline: StatuslineHost
  /** Накопленные снимки строки состояния и последняя калибровка по ним. */
  usage: UsageJournal
  /** Что не приняла последняя попытка поставить или снять хук. */
  usageProblem?: string
  /** Чем спрашивать Anthropic про лимиты (6.3). */
  oauthHost: OauthHost
  /** Последний ответ Anthropic и окно ограничения. Живёт в памяти: перезапуск спросит заново. */
  oauth: OauthState
  /**
   * Кто был живым на последнем снимке и насколько срочен — вход закрепления
   * строк в ленте (6.1).
   *
   * Берётся из уже собранного снимка, а не собирается заново на каждый запрос
   * ленты: живой слой обходит реестр процессов и хвосты транскриптов, и второй
   * такой обход ради одного списка — это работа, которую трей только что
   * сделал. Завершившихся здесь нет: строка «завершился 2 мин назад» держится в
   * попапе выдержкой, а в ленте закончившаяся задача — самая обычная, и держать
   * её наверху значит врать про «сейчас».
   */
  liveSessions?: ReadonlyMap<string, number>
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
 * Загрузчик обновлений (5.4).
 *
 * `electron-updater` — модуль CommonJS, и из ESM его именованные экспорты
 * приезжают не всегда: `import('electron-updater')` отдаёт пространство имён, у
 * которого настоящий объект лежит в `default`. Деструктуризация `{ autoUpdater }`
 * при этом не падает — она даёт `undefined`, и первое же обращение к полю
 * роняет проверку обновлений целиком, а приложение работает как ни в чём не
 * бывало. Нашла это проверка 9 в `package-smoke.ts`.
 *
 * Импорт ленивый: в неустановленном приложении обновлений нет вовсе, и тянуть
 * ради них модуль в память при каждом `npm run dev` незачем.
 */
async function loadUpdater(): Promise<AppUpdater> {
  const module = (await import('electron-updater')) as unknown as {
    autoUpdater?: AppUpdater
    default?: { autoUpdater?: AppUpdater }
  }
  const updater = module.autoUpdater ?? module.default?.autoUpdater
  if (updater === undefined) throw new Error('electron-updater не отдал autoUpdater')
  return updater
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
  const statusline: StatuslineHost = {
    claudeHome: sources.claudeHome,
    configDir: dirname(configPath()),
    platform: process.platform,
  }
  const runtime: Runtime = {
    db,
    live,
    config,
    liveOptions,
    configProblems: loaded.problems,
    // Автозапуск спрашивают у системы через `app`, и передаётся он объектом с
    // тремя методами, а не целиком: `main/config.ts` про Electron не знает и
    // знать не должен — его проверяют без запуска приложения.
    startup: app,
    update: initialUpdateState(app.getVersion(), app.isPackaged, config.updates.auto),
    statusline,
    usage: openJournal(statusline),
    // `net.fetch` из Electron, а не `globalThis.fetch` из Node, и это не вкус:
    // на `/api/oauth/usage` стоит Cloudflare, который отсекает Node по
    // отпечатку TLS. Замерено 11 августа одним и тем же токеном и одними и
    // теми же заголовками: `curl` и Chromium получают 200, `fetch` из Node,
    // `node:https` и `node:http2` — 403 все трое. Подставь сюда Node — и
    // источник молча не заработал бы ни у кого, а выглядело бы это как
    // «Anthropic не принял токен».
    oauthHost: {
      claudeHome: sources.claudeHome,
      platform: process.platform,
      fetch: net.fetch.bind(net),
    },
    oauth: openOauth(),
    issues: ingested?.issues ?? [],
  }
  // Тело хука меняется вместе с приложением, а лежит он в каталоге настроек и
  // сам собой не обновится. Ставить его здесь при этом нельзя: установка — это
  // правка чужого файла, и разрешает её человек кнопкой, а не запуск.
  refreshHook(statusline)
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
  let updaterReport: unknown
  let popupReport: unknown
  // Окно и присланная им высота — обработчику канала, который регистрируется
  // раньше, чем окно создано.
  let popup: BrowserWindow | undefined
  let measured: number | undefined
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
        // Смоук автозапуск не трогает: включить его значило бы записать
        // приложение в «Объекты входа» того, кто прогнал проверку.
        () => configReport(runtime),
        // И чужой файл настроек тоже: хук строки состояния ставится согласием
        // человека, а не прогоном проверки.
        () => configReport(runtime),
        () => configReport(runtime),
        // Второй источник лимитов смоук не включает и не спрашивает: включение
        // — это согласие человека на сетевой вызов его креденшелами, и прогон
        // проверки таким согласием не является.
        () => configReport(runtime),
        () => Promise.resolve(configReport(runtime)),
        // И в сеть не ходит: проверка обновлений — единственный сетевой вызов
        // продукта, который смоук мог бы задеть, и он обязан оставаться
        // проверкой того, что на диске.
        () => configReport(runtime),
        () => undefined,
        // Подгонка высоты — тем же кодом, что в приложении: смоук проверяет её
        // ниже, и заглушка здесь означала бы проверку заглушки.
        (height) => {
          measured = height
          if (popup !== undefined && !popup.isDestroyed()) fitPopup(popup, height)
        },
      ),
    )

    const window = createPopup('index', true)
    popup = window
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

    // Высота попапа по содержимому. Проверяется здесь, потому что увидеть это
    // может только настоящий браузер: юнит-тесты рендерят компоненты в строку и
    // высоты не считают вовсе, а вопрос ровно про неё. Ловится сразу три вещи:
    // рендерер не измерил (`ResizeObserver` не завёлся), измерил и не доехало
    // (канала нет), доехало и не применилось (окно не поменяло размер).
    for (let waited = 0; measured === undefined && waited < 3_000; waited += 100) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    const first = measured
    // Два кадра: `setContentSize` только что сдвинул границу, и мерить до
    // раскладки значит мерить прошлое состояние.
    const fit = (await window.webContents.executeJavaScript(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        inner: window.innerHeight,
        content: Math.ceil(document.getElementById('root').getBoundingClientRect().height),
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))))`,
    )) as {
      inner: number
      content: number
      scrollHeight: number
      scrollWidth: number
      innerWidth: number
    }
    // Окно **сжимается** вслед за содержимым. Отдельной проверкой, потому что
    // равенство выше на живой машине держится и без единой подгонки: список
    // агентов упирается в потолок, и окно, созданное на 600 точек, случайно
    // оказывается впору. Содержимое здесь ужимается насильно — правкой рамки
    // попапа, а не переменной потолка, которую окно пересчитывает на каждом
    // изменении размера.
    const SHRUNK = 300
    await window.webContents.executeJavaScript(
      `document.getElementById('root').firstElementChild.style.maxHeight = '${SHRUNK}px'`,
    )
    for (let waited = 0; measured !== SHRUNK && waited < 3_000; waited += 100) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    const [, shrunk] = window.getContentSize()
    // Попап обязан быть выпадашкой, а не окном. На macOS обычное окно
    // принадлежит своему рабочему столу, и клик по значку с другого стола
    // **переключает пространство**: человек нажал на значок в панели и уехал на
    // другой экран. Флаги эти выставляются в `createPopup` и снимаются молча —
    // с виду попап открывается, просто не там, где на него смотрят.
    const spaces = process.platform === 'darwin' ? window.isVisibleOnAllWorkspaces() : true
    popupReport = { ...fit, measured: first, shrunk, spaces, onTop: window.isAlwaysOnTop() }
    if (!spaces) problems.push('попап живёт на одном рабочем столе: клик со второго уедет на первый')
    if (!window.isAlwaysOnTop()) problems.push('попап не поверх окон: откроется под чужим окном')
    if (shrunk !== SHRUNK) {
      problems.push(`попап не сжался под содержимое: ${shrunk} точек вместо ${SHRUNK}`)
    }
    if (first === undefined) problems.push('попап не прислал высоту содержимого')
    else if (first < POPUP_MIN_HEIGHT || first > POPUP_MAX_HEIGHT) {
      problems.push(`попап намерил ${first} точек — вне ${POPUP_MIN_HEIGHT}…${POPUP_MAX_HEIGHT}`)
    }
    if (fit.content !== fit.inner) {
      problems.push(`окно попапа ${fit.inner} точек при содержимом ${fit.content}`)
    }
    // Прокрутка у самого окна: содержимое, не поместившееся в него хотя бы на
    // пиксель, даёт полосу поверх интерфейса — и прокручивает не список, а
    // попап целиком, вместе с рамкой.
    if (fit.scrollHeight > fit.inner || fit.scrollWidth > fit.innerWidth) {
      problems.push(
        `попап прокручивается сам: ${fit.scrollWidth}×${fit.scrollHeight} в окне ${fit.innerWidth}×${fit.inner}`,
      )
    }

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

    // Загрузчик обновлений (5.4) только **загружается**, без единого сетевого
    // вызова: проверить надо ровно то, что он доехал внутрь сборки. Не доехал
    // бы — приложение работало бы как ни в чём не бывало, а обновления молча
    // перестали бы существовать.
    try {
      const autoUpdater = await loadUpdater()
      updaterReport = { module: typeof autoUpdater.checkForUpdates === 'function' }
    } catch (error) {
      updaterReport = {
        module: false,
        error: error instanceof Error ? error.message : String(error),
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
      popup: popupReport,
      settings: settingsReport,
      // Автозапуск (5.3) только читается: включить его в проверке значило бы
      // прописать приложение в «Объекты входа» того, кто её прогнал. В
      // упакованном приложении здесь `available: true` — это и проверяет
      // `package-smoke.ts`, потому что в разработке он всегда `false`.
      startup: readStartup(app),
      updater: updaterReport,
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
  changeStartup: (enabled: boolean) => ConfigReport,
  changeStatusline: (enabled: boolean) => ConfigReport,
  refreshUsage: () => ConfigReport,
  changeOauth: (enabled: boolean) => ConfigReport,
  refreshOauth: () => Promise<ConfigReport>,
  checkUpdate: () => ConfigReport,
  installUpdate: () => void,
  resizePopup: (height: number) => void,
): IpcHandlers {
  return {
    'snapshot:get': () =>
      rememberLive(
        runtime(),
        withIndexing(
          runtime(),
          buildSnapshot(runtime().db, runtime().live, runtime().config, {
            issues: runtime().issues,
            oauth: oauthInput(runtime()),
          }),
        ),
      ),
    'limits:get': () =>
      limitsReport(
        runtime().db,
        Date.now(),
        runtime().config.limits.claude,
        undefined,
        runtime().oauth.snapshot,
      ).windows,
    'config:get': () => configReport(runtime()),
    'today:get': (filter) =>
      buildDayReport(runtime().db, filter, runtime().config.privacy, runtime().liveSessions),
    'task:get': (arg) => buildTaskCard(runtime().db, arg, runtime().config),
    'breakdown:get': (filter) => buildSpendScreen(runtime().db, filter),
    'history:get': (arg) => buildHistoryScreen(runtime().db, arg, runtime().config, Date.now()),
    'config:set': ({ patch }) => changeConfig(patch),
    // Автозапуск пишется в систему, а не в файл настроек, — но окну об этом
    // знать незачем: ответ тот же отчёт, и рассылается он так же.
    'startup:set': ({ enabled }) => changeStartup(enabled),
    // Хук строки состояния пишется в чужой файл настроек, поэтому канал зовётся
    // только кнопкой в окне — и никогда стартом приложения.
    'statusline:set': ({ enabled }) => changeStatusline(enabled),
    'usage:refresh': () => refreshUsage(),
    // Второй источник лимитов — тоже только кнопкой: канал включает согласие на
    // сетевой вызов, и звать его чем-то, кроме явного действия, нельзя.
    'oauth:set': ({ enabled }) => changeOauth(enabled),
    'oauth:refresh': () => refreshOauth(),
    'update:check': () => checkUpdate(),
    'update:install': () => installUpdate(),
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
    'popup:resize': ({ height }) => {
      resizePopup(height)
    },
    'app:quit': () => {
      app.quit()
    },
  }
}

/**
 * Запомнить, кто был живым и насколько срочен, — вход закрепления строк в
 * ленте (6.1).
 *
 * Стоит на пути снимка, а не внутри `buildSnapshot`: тот собирает то, что
 * прочитано, и знать про соседний экран ему незачем. Возвращает свой довод
 * нетронутым, чтобы не заводить второй вызов рядом с первым.
 *
 * Срочность — та же таблица, по которой упорядочен список в попапе
 * (`LIVE_URGENCY`, 2.1): один и тот же список на двух экранах обязан быть
 * упорядочен одинаково, иначе «сверху самый важный» означает разное в трее и в
 * окне.
 */
/** Разошлись ли числа настолько, чтобы переписывать настройку. */
function differs(current: number | null, next: number | null, epsilon: number): boolean {
  if (next === null) return false
  return current === null || Math.abs(current - next) > epsilon
}

/**
 * Что снимок трея должен знать про второй источник лимитов (6.3).
 *
 * Собирается здесь, а не читается в `buildSnapshot`: тот берёт всё параметрами
 * и про `Runtime` не знает — иначе его нельзя было бы проверить без запуска
 * приложения. Сети тут нет и в помине, только уже полученное.
 */
function oauthInput(runtime: Runtime): {
  enabled: boolean
  snapshot?: UsageSnapshot
  retryAt?: number
} {
  return {
    enabled: runtime.config.limits.claude.api.enabled,
    ...(runtime.oauth.snapshot === undefined ? {} : { snapshot: runtime.oauth.snapshot }),
    ...(runtime.oauth.throttle === undefined ? {} : { retryAt: runtime.oauth.throttle.retryAt }),
  }
}

function rememberLive(runtime: Runtime, snapshot: TraySnapshot): TraySnapshot {
  runtime.liveSessions = new Map(
    snapshot.agents
      .filter((agent) => agent.state !== 'done')
      .map((agent) => [agent.sessionId, LIVE_URGENCY[agent.state]]),
  )
  return snapshot
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
    height: page === 'gallery' ? 900 : POPUP_MAX_HEIGHT,
    show: false,
    frame: !frameless,
    resizable: page === 'gallery',
    skipTaskbar: frameless,
    // Попап — не окно, а выпадашка из панели, и на macOS разница не
    // косметическая. Обычное окно принадлежит рабочему столу, на котором
    // создано: клик по значку с другого стола **переключает пространство** —
    // человек нажал на значок в панели и уехал в другое приложение на другом
    // экране. `panel` делает окно вспомогательным (NSPanel), а
    // `setVisibleOnAllWorkspaces` ниже — общим для всех столов.
    ...(frameless && process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    // Поверх остальных: попап открывается над тем, с чем человек работает, и
    // уходить под чужое окно ему незачем — он живёт до первого клика мимо.
    alwaysOnTop: frameless,
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
  if (frameless) {
    // Видно на всех рабочих столах и поверх полноэкранного приложения. Второе
    // отдельным флагом: без него попап на полноэкранном окне не показывается
    // вовсе — значок нажат, а не происходит ничего.
    // `skipTransformProcessType` не даёт Electron дёргать тип процесса на
    // каждый показ: на macOS это моргание иконкой в доке у приложения, которое
    // из дока убрано намеренно.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    // Уровень меню, а не «просто поверх»: попап выпадает из панели, и над ним
    // не должно оказаться чужое окно, тоже объявившее себя верхним.
    window.setAlwaysOnTop(true, 'pop-up-menu')
  }
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
 * Подогнать попап под содержимое (`popup:resize`). Отвечает, изменился ли
 * размер: тот, кто окно двигает, зря пересчитывать угол не должен.
 *
 * Ставится **высота содержимого**, а не окна: в обычном режиме окно
 * безрамочное и это одно и то же, а под `--dev` попап поднимается с рамкой, и
 * высота окна включала бы её. Тогда рендерер мерил бы содержимое на рамку
 * короче, присылал бы новое число, и окно ползло бы вверх на каждом кадре —
 * молча и только в режиме разработки.
 *
 * Потолка два: макетные 600 и рабочая область экрана. Второй не украшение —
 * содержимое обрезается без всякого скролла (`overflow: hidden` на рамке
 * попапа), то есть попап, не поместившийся в экран, потерял бы подвал с суммой
 * за сутки, ничем этого не показав. Тот же потолок знает и рендерер, поэтому
 * до обрезания дело не доходит: здесь он стоит вторым рубежом.
 */
function fitPopup(window: BrowserWindow, height: number): boolean {
  const area = screen.getDisplayMatching(window.getBounds()).workArea
  const ceiling = Math.min(POPUP_MAX_HEIGHT, area.height - 2 * POPUP_MARGIN)
  const wanted = Math.min(Math.max(Math.round(height), POPUP_MIN_HEIGHT), ceiling)
  const [, current] = window.getContentSize()
  if (wanted === current) return false
  window.setContentSize(POPUP_WIDTH, wanted)
  return true
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
  /**
   * Нативный значок на macOS. Живёт вместо `tray`, а не рядом: два пункта в
   * панели означали бы два приложения. `undefined` — либо не macOS, либо
   * хелпер не поднялся, и тогда работает `tray`.
   */
  let bar: NativeBar | undefined
  /** Приложение выходит. Смерть хелпера после этого — норма, а не авария. */
  let quitting = false
  let timer: NodeJS.Timeout | undefined
  let tick = 0
  /** Когда приложение поднялось. Ноль — ещё не поднялось (см. `ACTIVATE_GRACE_MS`). */
  let readyAt = 0
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
    rememberLive(
      runtime!,
      withIndexing(
        runtime!,
        buildSnapshot(runtime!.db, runtime!.live, runtime!.config, {
          issues: runtime!.issues,
          oauth: oauthInput(runtime!),
        }),
      ),
    )

  /**
   * Меню трея (4.8). Пункт один, и он единственный, чего нельзя сделать из
   * окна: выгрузка расхода в файл. Собирается на каждый показ, потому что язык
   * меняется без перезапуска (3.6), а меню, собранное однажды, застыло бы на
   * языке запуска — та же ловушка, что с `t()` на верхнем уровне модуля.
   */
  /**
   * Меню по правой кнопке — одним списком на оба значка.
   *
   * У `Tray` меню строится Electron, у нативного хелпера — из тех же пунктов на
   * стороне Swift, и обратно приезжает `id`. Держать два списка нельзя: пункт,
   * добавленный в один, молча не появился бы во втором, а разница видна только
   * на той платформе, которой сейчас нет под рукой.
   */
  const trayActions = (): { id: string; label: string; run: () => void }[] => [
    { id: 'export', label: t('menu.export'), run: () => void exportToFile() },
    { id: 'quit', label: t('menu.quit'), run: () => app.quit() },
  ]

  const trayMenu = (): Menu => {
    const [first, ...rest] = trayActions()
    return Menu.buildFromTemplate([
      { label: first!.label, click: first!.run },
      { type: 'separator' },
      ...rest.map((action) => ({ label: action.label, click: action.run })),
    ])
  }

  /**
   * Выгрузка в файл. Формат выбирается расширением, которое человек назвал сам:
   * отдельный переключатель формата рядом с полем имени спрашивал бы дважды об
   * одном.
   */
  const exportToFile = async (): Promise<void> => {
    const config = runtime!.config
    const day = dayRange(Date.now(), config.ui.dayStartsAtHour)
    const range = { from: dayRange(day.from, config.ui.dayStartsAtHour, -29).from, to: day.to }
    const rows = exportRows(runtime!.db, range, 'task', config.ui.dayStartsAtHour)
    const target = await dialog.showSaveDialog({
      defaultPath: `agentmeter-${new Date(day.from).toISOString().slice(0, 10)}.csv`,
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    })
    if (target.canceled || target.filePath === undefined) return
    const json = target.filePath.toLowerCase().endsWith('.json')
    writeFileSync(target.filePath, json ? JSON.stringify(rows, null, 2) : toCsv(rows), 'utf8')
  }

  const notifyState = emptyNotifyState()
  /**
   * Показ уведомления. Всё решение — в `notify.ts`; здесь только вызов ОС и
   * клик, открывающий окно. `isSupported` спрашивается каждый раз, а не при
   * старте: на Linux служба уведомлений может подняться позже приложения.
   */
  const show = (notices: readonly Notice[]): void => {
    if (notices.length === 0 || !Notification.isSupported()) return
    for (const notice of notices) {
      const item = new Notification({ title: notice.title, body: notice.body })
      item.on('click', () => openMainWindow('today'))
      item.show()
    }
  }

  /**
   * Дочитать снимок строки состояния и, если набежало новое, пересчитать вес
   * чтения кэша (1.9).
   *
   * Стоит на опросе трея, а не на вотчере файла: снимок переписывается на
   * каждую отрисовку строки состояния — вотчер дёргался бы десятки раз на одно
   * наблюдение. Сам разбор дешёвый (сравнение времени файла), а калибровка —
   * нет: она читает запросы Claude за дни, и потому идёт по таймеру.
   */
  const collectUsage = (): void => {
    if (runtime === undefined) return
    if (drainSnapshot(runtime.statusline, runtime.usage) === null) return
    if (Date.now() - runtime.usage.calibratedAt < CALIBRATE_EVERY_MS) return
    applyCalibration(recalibrate(runtime.db, runtime.usage))
  }

  /**
   * Спросить лимиты у Anthropic, если пора (6.3).
   *
   * Стоит на том же опросе трея, что и дочитывание снимка, — и это безопасно
   * ровно потому, что решение «пора ли» принимает `pollOauth`: выключенная
   * настройка, свежий кэш, окно ограничения и 401 отсекаются там, до всякой
   * сети. Опрос идёт раз в секунду, запрос — раз в четверть часа.
   *
   * Ошибка сюда не поднимается: не дозвонились — прежний снимок остаётся на
   * экране со своим возрастом, и падать из-за этого трею незачем.
   */
  const collectOauth = (): void => {
    if (runtime === undefined) return
    if (!runtime.config.limits.claude.api.enabled) return
    void pollOauth(runtime.oauthHost, runtime.oauth, runtime.usage, { enabled: true }).then(
      (fresh) => {
        if (fresh === null || runtime === undefined) return
        applyCalibration(recalibrate(runtime.db, runtime.usage))
        emit('config:changed', configReport(runtime))
      },
      () => undefined,
    )
  }

  /**
   * Записать измеренное в настройки — но только измеренное.
   *
   * Вес чтения кэша уезжает в конфиг всегда, когда калибровка сошлась: в логах
   * его нет, спросить не у кого, и другого источника у этого числа не будет.
   * А вот потолки записываются, только если человек **не** выбирал план: его
   * выбор — это заявление о подписке, и перебивать заявление измерением значит
   * драться с кнопкой, которую он только что нажал. Разошлись — видно в
   * настройках, решает он.
   */
  const applyCalibration = (calibration: Calibration): void => {
    if (!calibration.ok || runtime === undefined) return
    const claude = runtime.config.limits.claude
    const patch: DeepPartial<Config['limits']['claude']> = {}
    if (differs(claude.cacheReadWeight, calibration.cacheReadWeight, 1e-3)) {
      patch.cacheReadWeight = calibration.cacheReadWeight
    }
    if (claude.plan === null) {
      if (differs(claude.fiveHourCap, calibration.fiveHourCap, 1)) {
        patch.fiveHourCap = calibration.fiveHourCap
      }
      if (differs(claude.weeklyCap, calibration.weeklyCap, 1)) {
        patch.weeklyCap = calibration.weeklyCap
      }
    }
    if (Object.keys(patch).length > 0) changeConfig({ limits: { claude: patch } })
  }

  const poll = (): void => {
    tick += 1
    // До проверки «смотрит ли кто-то»: наблюдение строки состояния такое же
    // невосстановимое, как журнал времён жизни рядом. Процент окна, не
    // записанный сегодня, задним числом не узнает никто — ни мы, ни провайдер.
    collectUsage()
    // Рядом и по той же причине: процент, не спрошенный сегодня, задним числом
    // не узнает никто. Сеть при этом трогается раз в четверть часа и только при
    // включённой настройке — решает это `pollOauth`, а не частота опроса.
    collectOauth()
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
    // Уведомления смотрят на **каждый** снимок, а не только на видимые: попап
    // закрыт как раз тогда, когда человек занят чем-то другим, и молчать в этот
    // момент значит молчать всегда, когда уведомление и нужно.
    show(planNotifications(notifyState, current, runtime!.config))
  }

  /**
   * Куда прижимать попап. У нативного значка рамку присылает хелпер, у `Tray`
   * её отдаёт Electron; `undefined` — пункта ещё нет, и попап встанет по
   * курсору, а не в угол экрана.
   */
  const anchor = (): Rectangle | undefined => bar?.frame() ?? tray?.getBounds()

  const paintTray = (current: TraySnapshot): void => {
    if (bar === undefined && (tray === undefined || tray.isDestroyed())) return
    const state = trayState(current, runtime!.config)
    // Отпечаток — ровно то, что видно на иконке. Процент округляется до целого:
    // полоса в 16 точек дробей не показывает, а перерисовка на каждый десятый
    // процента — это та же лишняя работа, только незаметная.
    const key = `${state.agents.join(',')}|${levelFor(state)}|${
      state.limitPercent === undefined ? '—' : Math.round(state.limitPercent)
    }`
    if (key === painted) return
    painted = key
    const image = trayIcon(state)
    const tooltip = trayTooltip(state)
    if (bar !== undefined) {
      // Хелперу растр уезжает картинкой: точки макетные (16), пикселей вдвое —
      // экран ретиновый, и картинка в точку размером выглядела бы мылом.
      bar.setIcon(image.toPNG({ scaleFactor: 2 }), TRAY_SIZE, tooltip)
      return
    }
    tray!.setImage(image)
    tray!.setToolTip(tooltip)
  }

  const resizePopup = (height: number): void => {
    if (window === undefined || window.isDestroyed() || gallery) return
    // Открытый попап прижат к трею: снизу на Windows и Linux — там окно,
    // выросшее на сто точек, уехало бы под панель, если не пересчитать угол.
    if (fitPopup(window, height) && window.isVisible()) positionPopup(window, anchor())
  }

  const toggle = (): void => {
    if (window === undefined || window.isDestroyed()) return
    if (window.isVisible()) {
      window.hide()
      return
    }
    positionPopup(window, anchor())
    emit('live:update', snapshot())
    window.show()
    window.focus()
  }

  /** Значок средствами Electron. Работает везде, кроме macOS 26 — см. `menubar.ts`. */
  const createTray = (state: TrayState): Tray => {
    const one = new Tray(trayIcon(state))
    one.setToolTip(trayTooltip(state))
    one.on('click', toggle)
    // Контекстное меню вешается на правую кнопку, а не через `setContextMenu`:
    // тот на macOS перехватывает и левый клик, а левым открывается попап —
    // главное, ради чего значок в трее и стоит.
    one.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
    return one
  }

  /**
   * Значок нативным хелпером (macOS).
   *
   * `undefined` — хелпера нет или он не поднялся; вызывающий обязан ответить
   * обычным `Tray`. Молчаливое отсутствие значка — ровно та поломка, из-за
   * которой хелпер и написан: приложение работает, а выглядит незапущенным.
   */
  const startBar = (state: TrayState): NativeBar | undefined => {
    const started = startNativeBar({
      binary: barBinaryPath(app.isPackaged, process.resourcesPath, join(here, '../..')),
      onClick: toggle,
      onMenu: (id) => trayActions().find((action) => action.id === id)?.run(),
      onExit: () => {
        bar = undefined
        // Хелпер умер посреди работы — значок исчез вместе с ним. Кроме выхода
        // из приложения, это всегда авария, и остаться без единственного входа
        // хуже, чем показать значок, который на этой macOS может не встать.
        if (quitting || tray !== undefined) return
        tray = createTray(trayState(snapshot(), runtime!.config))
        painted = ''
      },
    })
    if (started === undefined) return undefined
    started.setMenu(barMenu())
    started.setIcon(trayIcon(state).toPNG({ scaleFactor: 2 }), TRAY_SIZE, trayTooltip(state))
    return started
  }

  /** Те же пункты, что у `trayMenu`, но списком для хелпера: разделитель — пустой. */
  const barMenu = (): { id?: string; label?: string }[] => {
    const [first, ...rest] = trayActions()
    return [{ id: first!.id, label: first!.label }, {}, ...rest.map(({ id, label }) => ({ id, label }))]
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
    const wasLocale = current.ui.locale
    const report = setConfig(runtime!, patch)
    const next = runtime!.config
    nativeTheme.themeSource = next.ui.theme
    // Меню у `Tray` строится на каждый клик и язык берёт сам; у хелпера оно
    // отправлено один раз и без этой строки осталось бы на языке запуска —
    // причём заметно это только по правой кнопке, куда заглядывают редко.
    if (next.ui.locale !== wasLocale) bar?.setMenu(barMenu())
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
    // Выключенная проверка обновлений замолкает сразу, а не со следующего
    // запуска: это единственный сетевой вызов продукта, и «выключил, но он ещё
    // разок сходит» — не то, что обещает тумблер.
    runtime!.update = applyAuto(runtime!.update, next.updates.auto)
    emit('config:changed', report)
    return report
  }

  /**
   * Автозапуск (5.3): записать в систему и разослать тем же событием.
   *
   * Ничего, кроме записи, здесь нет — ни таймеров, ни вотчера: настройка
   * работает не в этом запуске, а в следующем входе в систему. Событие всё
   * равно уходит, потому что тумблер стоит в окне, а состояние приезжает из
   * системы: показать желаемое вместо действительного — то же враньё, что
   * тумблер без поведения.
   */
  const changeStartup = (enabled: boolean): ConfigReport => {
    const report = setStartup(runtime!, enabled)
    emit('config:changed', report)
    return report
  }

  /**
   * Хук строки состояния (1.9): поставить или снять и разослать.
   *
   * Отдельно от `changeConfig` по той же причине, что автозапуск, только резче:
   * пишется он в **чужой** файл настроек. Единственный путь сюда — кнопка в
   * окне; ни старт приложения, ни применение конфига этого канала не трогают.
   *
   * Калибровка пересчитывается сразу после установки: журнал мог остаться с
   * прошлого раза, и показывать «0 снимков» над непустым файлом было бы враньём
   * ровно того сорта, от которого этап и затевался.
   */
  const changeStatusline = (enabled: boolean): ConfigReport => {
    let report = setStatusline(runtime!, enabled)
    if (enabled && runtime!.usage.snapshots.length > 0) {
      applyCalibration(recalibrate(runtime!.db, runtime!.usage))
      report = configReport(runtime!)
    }
    emit('config:changed', report)
    return report
  }

  /**
   * Пересчитать вес по журналу руками (1.9).
   *
   * Кнопка нужна ровно затем, зачем «Проверить» у обновлений: автоматический
   * пересчёт идёт раз в пять минут, и это верно для фона и мучительно сразу
   * после установки хука, когда хочется увидеть, сошлось ли. Дочитывание снимка
   * тут же рядом — не ради скорости (опрос трея и так раз в секунду), а чтобы
   * кнопка означала «посмотри на всё, что есть на диске», а не «пересчитай то,
   * что успел заметить».
   *
   * Позвать сам хук отсюда нельзя, и это не недоделка: строку состояния рисует
   * Claude Code, проценты приезжают в его ответе API, и наш скрипт, запущенный
   * руками, получил бы пустой stdin и переписал бы снимок пустотой.
   */
  const refreshUsage = (): ConfigReport => {
    drainSnapshot(runtime!.statusline, runtime!.usage)
    applyCalibration(recalibrate(runtime!.db, runtime!.usage))
    const report = configReport(runtime!)
    emit('config:changed', report)
    return report
  }

  /**
   * Разрешить или запретить запрос лимитов у Anthropic (6.3).
   *
   * Запроса отсюда не уходит: тумблер — это согласие, а не команда. Первый
   * запрос сделает таймер или кнопка «Спросить сейчас».
   */
  const changeOauth = (enabled: boolean): ConfigReport => {
    const report = setOauth(runtime!, enabled)
    emit('config:changed', report)
    return report
  }

  /**
   * Спросить проценты прямо сейчас (6.3).
   *
   * Единственная кнопка продукта, кроме проверки обновлений, которая ходит в
   * сеть. `force` снимает кэш — но не окно ограничения и не 401: кнопка не
   * должна уметь ломать чужой запрет, иначе человек, нажимающий её от
   * нетерпения, продлевает себе тот самый запрет.
   *
   * Калибровка пересчитывается только на новом снимке: ответ, совпавший с уже
   * записанным, ничего к журналу не добавил, а полный проход по запросам Claude
   * стоит секунд.
   */
  const refreshOauth = async (): Promise<ConfigReport> => {
    const fresh = await pollOauth(runtime!.oauthHost, runtime!.oauth, runtime!.usage, {
      enabled: runtime!.config.limits.claude.api.enabled,
      force: true,
    })
    if (fresh !== null) applyCalibration(recalibrate(runtime!.db, runtime!.usage))
    const report = configReport(runtime!)
    emit('config:changed', report)
    return report
  }

  /**
   * Автообновление (5.4) — вся механика в одном месте.
   *
   * `electron-updater` подключается лениво, первым обращением: в неустановленном
   * приложении он не работает вовсе, и тянуть его в память при каждом `npm run
   * dev` незачем.
   */
  const onUpdateEvent = (event: UpdateEvent): void => {
    if (runtime === undefined) return
    const before = runtime.update
    runtime.update = nextUpdateState(before, event)
    if (runtime.update !== before) emit('update:state', runtime.update)
  }

  let updater: AppUpdater | undefined
  const openUpdater = async (): Promise<AppUpdater> => {
    if (updater !== undefined) return updater
    const autoUpdater = await loadUpdater()
    // Скачивание — сразу за находкой: спрашивать «качать ли» отдельной кнопкой
    // значит выдумать шаг, которого человек не просил. Установка при этом
    // остаётся его решением — приложение не перезапускает себя само.
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('update-available', (info) => onUpdateEvent({ type: 'found', version: info.version }))
    autoUpdater.on('update-not-available', () => onUpdateEvent({ type: 'none' }))
    autoUpdater.on('download-progress', (progress) =>
      onUpdateEvent({ type: 'progress', percent: progress.percent }),
    )
    autoUpdater.on('update-downloaded', (info) => onUpdateEvent({ type: 'ready', version: info.version }))
    autoUpdater.on('error', (error) => onUpdateEvent({ type: 'error', message: error.message }))
    updater = autoUpdater
    return autoUpdater
  }

  const checkUpdate = (manual = true): ConfigReport => {
    const report = configReport(runtime!)
    if (!mayCheck(runtime!.update, runtime!.config.updates.auto, manual)) return report
    onUpdateEvent({ type: 'check' })
    void openUpdater()
      .then((one) => one.checkForUpdates())
      .catch((error: unknown) =>
        onUpdateEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
      )
    return configReport(runtime!)
  }

  const installUpdate = (): void => {
    if (runtime?.update.phase !== 'ready' || updater === undefined) return
    updater.quitAndInstall()
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
      createHandlers(
        () => runtime!,
        openMainWindow,
        changeConfig,
        changeStartup,
        changeStatusline,
        refreshUsage,
        changeOauth,
        refreshOauth,
        () => checkUpdate(),
        installUpdate,
        resizePopup,
      ),
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
      const state = trayState(snapshot(), runtime.config)
      // На macOS значок ведёт нативный хелпер: `Tray` из Electron 43 там в
      // панель не встаёт вовсе (замеры — в шапке `menubar.ts`). На остальных
      // платформах `Tray` работает, и второй механизм ради единообразия
      // означал бы вторую поломку.
      if (process.platform === 'darwin') bar = startBar(state)
      if (bar === undefined) tray = createTray(state)
      // На macOS иконка в доке приложению без окон не нужна.
      if (process.platform === 'darwin') app.dock?.hide()
    }

    driveIngest(runtime, (progress) => {
      emit('index:progress', progress)
      if (listeners().length > 0) emit('live:update', snapshot())
    })

    timer = setInterval(poll, runtime.config.live.pollMs)

    // Проверка обновлений (5.4). Первая — не сразу: при старте идёт первый
    // проход индекса, и сетевой вызов посреди него отнимает время у того
    // единственного экрана, который человек в этот момент видит. Дальше раз в
    // шесть часов — приложение живёт в трее неделями, и «проверять при
    // запуске» у него означало бы «не проверять».
    setTimeout(() => checkUpdate(false), UPDATE_FIRST_DELAY_MS)
    setInterval(() => checkUpdate(false), UPDATE_EVERY_MS)

    // Последней строкой, а не первой: до неё `activate` — это ещё запуск.
    readyAt = Date.now()
  })

  /**
   * Два жеста «открой уже открытое»: клик по значку в доке и повторный запуск
   * из Spotlight или Finder.
   *
   * Приложение без окон достижимо ровно одним способом — значком в menu bar, а
   * его macOS прячет молча, когда строка переполнена; на ноутбуке с чёлкой это
   * будни, а не край. В такой день приложение работает, считает и недостижимо:
   * второй запуск тихо выходил по замку, дока у трейного приложения нет.
   * Поэтому оба жеста ведут в главное окно — это же и аварийный выход из
   * спрятанного значка.
   *
   * `activate` прилетает и от самого запуска, а не только от клика. Открывать
   * по нему окно без разбора нельзя: с автозапуском (5.3) человек встречал бы
   * окно статистики при каждом входе в систему, а приложение обязано стартовать
   * тихо. Различия в событии нет, поэтому первые секунды после готовности оно
   * не считается кликом.
   */
  const reopen = (): void => {
    if (runtime === undefined || gallery) return
    openMainWindow('today')
  }
  app.on('second-instance', reopen)
  app.on('activate', () => {
    if (readyAt === 0 || Date.now() - readyAt < ACTIVATE_GRACE_MS) return
    reopen()
  })

  app.on('window-all-closed', () => {
    // Попап живёт в трее: закрытое окно — это норма, а не выход из приложения.
    // Закрытое главное окно — тем более: приложение продолжает считать.
    if (windowed) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    if (timer) clearInterval(timer)
    tray?.destroy()
    // Хелпер — отдельный процесс, и своей смерти от закрытия приложения он не
    // видит: без этой строки значок остался бы в панели пережившим приложение.
    bar?.destroy()
    if (runtime) closeRuntime(runtime)
  })
}

main()
