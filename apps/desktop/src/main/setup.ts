/**
 * Окно первичной настройки (7.3): что нашлось на диске, чем кончается мастер и
 * когда он показывается.
 *
 * Электрона здесь нет, кроме типов: окно создаётся переданным конструктором, а
 * весь порядок (первый запуск → мастер → «Начать» → попап) собран в `SetupFlow`
 * с подставными шагами. Иначе «второй раз мастер не показывается» и «крестик =
 * Пропустить» проверялись бы только запуском приложения, то есть вручную.
 *
 * Главное правило этапа — **мастер не вводит настроек, которых нет в
 * «Настройках»**. Поэтому конец мастера не пишет в файл сам, а проходит теми же
 * входами, что и разделы настроек: `config:set` для полей, согласие на сеть
 * через `oauth:set`, автозапуск через `startup:set`. Свой путь записи завёл бы
 * второй набор правил валидации и второй первый запуск.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  claudeHome,
  codexHome,
  discoverSources,
  type Config,
  type Db,
  type Provider,
} from '@agentmeter/core'
import type {
  ConfigReport,
  DeepPartial,
  SetupFinish,
  SetupProviderScan,
  SetupScan,
} from '@agentmeter/ipc'

/** Размер окна мастера — 640×620 из макета (строка 1807), внутренний. */
export const SETUP_WIDTH = 640
export const SETUP_HEIGHT = 620

/** Мастер показывается, пока он не пройден и не пропущен. */
export function setupDue(config: Config): boolean {
  return !config.setup.completed
}

/**
 * Первый ли это запуск — по тому, что лежало на диске **до** открытия индекса.
 *
 * Файл настроек пишется только при правке настройки или закрытии главного
 * окна, поэтому «нет файла» ещё не значит «новый человек»: тот, кто жил одним
 * попапом, файла не завёл ни разу. Индекс такой человек завёл наверняка — он
 * и есть след прежних запусков, и мастер ему не показывается (`completed` в
 * памяти; в файл уйдёт с первой правкой).
 *
 * Новому человеку флаг, наоборот, пишется сразу явным `false`: иначе индекс,
 * заведённый этим же запуском, при следующем объявил бы его прежним, и мастер,
 * брошенный выходом из приложения, не вернулся бы.
 */
export function settleFirstRun(
  config: Config,
  existed: { config: boolean; index: boolean },
  save: (config: Config) => void,
): void {
  if (existed.config || !setupDue(config)) return
  if (existed.index) {
    config.setup.completed = true
    return
  }
  save(config)
}

/**
 * Пути конфига, которые мастер вправе записать (7.3), — и ни одного больше.
 *
 * Тот же список, что `SETUP_FIELDS` окна, без автозапуска (он живёт в системе);
 * тест держит их равными. Канал `setup:finish` пишет только эти пути: окно
 * мастера не должно мочь записать этим входом что угодно ещё — каталоги логов,
 * снимок строки состояния, — даже если `config:set` рядом это и умеет.
 */
export const SETUP_CONFIG_PATHS = [
  'alerts.warnAtPercent',
  'alerts.dangerAtPercent',
  'alerts.notifyOnWaiting',
  'alerts.notifyOnDone',
  'privacy.hidePrompts',
  'ui.theme',
  'limits.claude.api.enabled',
  'limits.codex.api.enabled',
  'updates.auto',
] as const

/** Вырезать из патча только пути мастера; чего в патче нет — не появляется. */
function pickSetupPaths(patch: unknown): DeepPartial<Config> {
  const out: Record<string, unknown> = {}
  for (const path of SETUP_CONFIG_PATHS) {
    const keys = path.split('.')
    let node: unknown = patch
    for (const key of keys) {
      node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined
    }
    if (node === undefined) continue
    let into = out
    for (const key of keys.slice(0, -1)) {
      into = (into[key] ??= {}) as Record<string, unknown>
    }
    into[keys.at(-1)!] = node
  }
  return out as DeepPartial<Config>
}

/**
 * Что лежит на диске у провайдеров — без индексации и без записи.
 *
 * Файлы и байты — обход тем же `discoverSources`, что и первый проход, чтобы
 * цифры мастера были тем, что действительно будет прочитано (включая
 * дополнительные каталоги из конфига). `ConfigReport.sources` здесь не годится:
 * он считается из индекса и до первого прохода даёт нули.
 *
 * Модели — из индекса: то, что проход уже разобрал. Пока он не дошёл ни до
 * одного запроса, список пуст, и окно говорит «появятся после чтения логов».
 * Синтетические записи самого CLI (`<synthetic>`) моделью не считаются.
 */
export function scanSetup(db: Db, config: Config): SetupScan {
  const dirs: Record<Provider, string> = {
    claude: join(claudeHome(config), 'projects'),
    codex: join(codexHome(config), 'sessions'),
  }
  const totals: Record<Provider, { files: number; bytes: number }> = {
    claude: { files: 0, bytes: 0 },
    codex: { files: 0, bytes: 0 },
  }
  for (const file of discoverSources({
    claudeHome: claudeHome(config),
    codexHome: codexHome(config),
    extra: config.sources.extra,
  })) {
    const total = totals[file.provider]
    total.files += 1
    try {
      total.bytes += statSync(file.path).size
    } catch {
      // Файл мог исчезнуть между обходом и `stat` — Claude Code чистит логи сам.
    }
  }

  const models: Record<Provider, string[]> = { claude: [], codex: [] }
  const rows = db.all<{ provider: Provider; model: string }>(
    `SELECT DISTINCT s.provider AS provider, r.model AS model
       FROM requests r JOIN sessions s ON s.id = r.session_id
      WHERE r.model <> '' AND r.model NOT LIKE '<%'
      ORDER BY s.provider, r.model`,
  )
  for (const row of rows) models[row.provider]?.push(row.model)

  const providers: SetupProviderScan[] = (['claude', 'codex'] as const).map((provider) => ({
    provider,
    path: dirs[provider],
    found: totals[provider].files > 0,
    files: totals[provider].files,
    bytes: totals[provider].bytes,
    models: models[provider],
  }))
  return { providers }
}

/** Входы записи, которыми мастер пользуется вместо собственного пути в файл. */
export interface FinishDeps {
  config(): Config
  /** Включён ли автозапуск сейчас — по слову системы, не по конфигу. */
  startupEnabled(): boolean
  changeConfig(patch: DeepPartial<Config>): ConfigReport
  changeOauth(provider: Provider, enabled: boolean): ConfigReport
  changeStartup(enabled: boolean): ConfigReport
}

/**
 * Записать итог мастера.
 *
 * - Согласие на запрос лимитов уходит каналом `oauth:set`, а не просто полем
 *   патча: выключение там стирает накопленный ответ, и экран не показывал бы
 *   проценты под выключенным тумблером. Только если значение **меняется** —
 *   «Начать» с нетронутыми тумблерами не должно ничего трогать.
 * - Автозапуск пишется в систему и только при смене, по той же причине.
 * - `setup.completed` приходит от нас, а не от окна: из присланного патча
 *   берутся только пути `SETUP_CONFIG_PATHS`, остальное (и `setup`) отбрасывается.
 *
 * Пустой патч без `startup` — это «Пропустить»: файл становится дефолтным с
 * одним отличием, `setup.completed: true`. Своего набора значений у пропуска
 * нет и быть не должно — иначе у продукта два разных первых запуска.
 */
export function finishSetup(deps: FinishDeps, arg: SetupFinish): ConfigReport {
  const patch = pickSetupPaths(arg.patch ?? {})

  for (const provider of ['claude', 'codex'] as const) {
    const limits = patch.limits?.[provider]
    const wanted = limits?.api?.enabled
    if (limits?.api === undefined || wanted === undefined) continue
    delete limits.api.enabled
    if (typeof wanted === 'boolean' && wanted !== deps.config().limits[provider].api.enabled) {
      deps.changeOauth(provider, wanted)
    }
  }
  if (typeof arg.startup === 'boolean' && arg.startup !== deps.startupEnabled()) {
    deps.changeStartup(arg.startup)
  }
  return deps.changeConfig({ ...patch, setup: { completed: true } })
}

/** Часть окна, нужная порядку показа; настоящий `BrowserWindow` ей подходит. */
export interface SetupWindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  close(): void
  once(event: 'closed', listener: () => void): unknown
}

export interface SetupFlowDeps {
  /** Мастер ещё не пройден. */
  due(): boolean
  /** Приложение выходит: окно закрылось не рукой человека, и это не «Пропустить». */
  quitting(): boolean
  /** Поднять окно мастера. Показ по `ready-to-show` — забота того, кто поднимает. */
  create(): SetupWindowLike
  finish(arg: SetupFinish): ConfigReport
  /** После первого запуска окно уходит в трей и открывается попап. */
  afterFirstRun(): void
}

export interface SetupFlow {
  /** Первый запуск: показать мастер, если он не пройден. */
  showIfDue(): boolean
  /** `setup:open`: показать мастер независимо от флага. */
  open(): void
  finish(arg: SetupFinish): ConfigReport
  isOpen(): boolean
}

/**
 * Порядок показа.
 *
 * - Второго окна мастера не бывает: повторный `open` поднимает прежнее.
 * - Окно, закрытое крестиком, — это «Пропустить»: иначе человек, закрывший
 *   мастер, увидел бы его снова при каждом запуске. Но только при **первом**
 *   запуске: повторно открытый мастер ничего не пропускает — флаг уже стоит.
 * - Выход из приложения при открытом мастере пропуском не считается: человек
 *   ничего не решил, и мастер вернётся в следующий раз.
 */
export function createSetupFlow(deps: SetupFlowDeps): SetupFlow {
  let win: SetupWindowLike | undefined
  let firstRun = false
  let finished = false
  /** «Начать» при первом запуске: попап — когда окно мастера уже закрылось. */
  let popupOnClose = false

  const alive = (): boolean => win !== undefined && !win.isDestroyed()

  const open = (): void => {
    if (win !== undefined && alive()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return
    }
    firstRun = deps.due()
    finished = false
    const created = deps.create()
    win = created
    created.once('closed', () => {
      win = undefined
      if (popupOnClose) {
        popupOnClose = false
        deps.afterFirstRun()
        return
      }
      if (finished || deps.quitting()) return
      finished = true
      if (!firstRun) return
      firstRun = false
      deps.finish({ patch: {} })
      deps.afterFirstRun()
    })
  }

  return {
    showIfDue: () => {
      if (!deps.due()) return false
      open()
      return true
    },
    open,
    finish: (arg) => {
      const report = deps.finish(arg)
      finished = true
      const wasFirstRun = firstRun
      firstRun = false
      // Попап открывается **после** закрытия окна мастера, а не рядом с ним:
      // закрытие последнего окна на macOS прячет иконку дока, приложение теряет
      // фокус, и попап, открытый до этого, тут же закрылся бы по `blur`. Тот же
      // порядок, что у крестика.
      if (win !== undefined && alive()) {
        popupOnClose = wasFirstRun
        win.close()
      } else if (wasFirstRun) {
        deps.afterFirstRun()
      }
      return report
    },
    isOpen: alive,
  }
}

/**
 * Окно мастера: обычная рамка системы, размер фиксированный.
 *
 * Скругление, тень и обводка из макета (строка 1812) нарисованы вокруг окна
 * дизайнером — рамку даёт операционная система, как и у главного окна. Размер
 * 640×620 — **внутренний** (`useContentSize`): шапку заголовка рисует система и
 * в макетные числа она не входит.
 */
export function createSetupWindow(
  Window: typeof BrowserWindow,
  paths: { web: string; preload: string },
): BrowserWindow {
  const window = new Window({
    width: SETUP_WIDTH,
    height: SETUP_HEIGHT,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Agentmeter',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // На Windows и Linux Electron вешает на окно с рамкой меню приложения по
  // умолчанию (File, Edit, View…): мастеру оно не нужно, а на Windows ещё и
  // раздувало внутреннюю высоту — смоук на раннере мерил 640×646 вместо
  // 640×620. На macOS меню общее на приложение, и вызов ничего не меняет.
  window.removeMenu()
  void window.loadFile(`${paths.web}/setup.html`)
  return window
}
