import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIG,
  ingestAll,
  loadConfig,
  openDb,
  setLocale as setCoreLocale,
  type Config,
  type Db,
} from '@agentmeter/core'
import { IPC_CALLS, type ConfigReport, type IndexProgress, type SetupScan } from '@agentmeter/ipc'
import { configReport, setConfig, setOauth, setStartup, type ConfigTarget } from '../src/main/config.ts'
import { openJournal } from '../src/main/usage.ts'
import { openOauth } from '../src/main/oauth.ts'
import { initialUpdateState } from '../src/main/update.ts'
import { openCodexOauth } from '../src/main/codex-oauth.ts'
import { readStartup } from '../src/main/startup.ts'
import {
  createSetupFlow,
  finishSetup,
  scanSetup,
  settleFirstRun,
  SETUP_CONFIG_PATHS,
  setupDue,
  type FinishDeps,
  type SetupFlowDeps,
  type SetupWindowLike,
} from '../src/main/setup.ts'
import {
  RESCAN_EVERY_MS,
  SETUP_FIELDS,
  draftFromReport,
  finishArg,
  initialSetupState,
  setupPatch,
  setupProgress,
  setupReducer,
  shouldRescan,
  skipArg,
  type SetupDraft,
} from '../src/renderer/setup.ts'
import { SettingsAlerts } from '../src/renderer/components/SettingsAlerts.tsx'
import { SettingsApp } from '../src/renderer/components/SettingsApp.tsx'
import { SettingsAppearance } from '../src/renderer/components/SettingsAppearance.tsx'
import { SettingsPrivacy } from '../src/renderer/components/SettingsPrivacy.tsx'
import { SettingsUsage } from '../src/renderer/components/SettingsUsage.tsx'
import { SetupFrame } from '../src/renderer/components/SetupFrame.tsx'
import { SetupProviderCard } from '../src/renderer/components/SetupProviderCard.tsx'
import { SetupStepBehavior } from '../src/renderer/components/SetupStepBehavior.tsx'
import { SetupStepSources } from '../src/renderer/components/SetupStepSources.tsx'
import { SetupStepThresholds } from '../src/renderer/components/SetupStepThresholds.tsx'
import { SetupWizard } from '../src/renderer/components/SetupWizard.tsx'
import { setLocale } from '../src/renderer/format.ts'

/**
 * Окно первичной настройки (7.3).
 *
 * Проверки названы поломкой, которую ловят. Главная — не «нарисовалось», а три
 * обещания этапа: «Пропустить» даёт дефолты конфига, а не свой набор; каждый
 * контрол мастера пишет то же поле, что раздел «Настроек»; мастер не держит
 * индекс. Всё, что пишет на диск, идёт во временный каталог.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const rendererDir = fileURLToPath(new URL('../src/renderer/', import.meta.url))

let dir: string
let db: Db
const hosts: Array<ConfigTarget['startup'] & { openAtLogin: boolean; writes: number }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-setup-'))
  // `configPath()` смотрит на эту переменную — иначе тест писал бы в настройки
  // человека, который его запустил.
  process.env['AGENTMETER_HOME'] = dir
  // На Linux автозапуск — файл в `$XDG_CONFIG_HOME/autostart`, а не настройка
  // подделки `app`: без подмены тест писал бы в автозапуск того, кто его
  // запустил, и проверял бы поле подделки, которое на Linux не меняется.
  process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg')
  db = openDb(join(dir, 'index.sqlite')).db
  setCoreLocale('ru')
  setLocale('ru')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env['AGENTMETER_HOME']
  delete process.env['XDG_CONFIG_HOME']
  hosts.length = 0
})

/** Подделка `app`: помнит записанное и считает записи. */
function fakeHost(packaged = true) {
  const host = {
    isPackaged: packaged,
    openAtLogin: false,
    writes: 0,
    getLoginItemSettings() {
      return { openAtLogin: this.openAtLogin }
    },
    setLoginItemSettings(settings: { openAtLogin: boolean }) {
      this.writes += 1
      this.openAtLogin = settings.openAtLogin
    },
  }
  hosts.push(host)
  return host
}

function makeTarget(): ConfigTarget {
  return {
    db,
    config: structuredClone(DEFAULT_CONFIG),
    liveOptions: { idleMs: DEFAULT_CONFIG.live.idleMs, claudeLimits: DEFAULT_CONFIG.limits.claude },
    configProblems: [],
    startup: fakeHost(),
    update: initialUpdateState('0.1.0', true, true),
    usage: openJournal({ configDir: dir }),
    oauthHost: {
      claudeHome: join(dir, 'claude'),
      platform: 'darwin',
      fetch: () => {
        throw new Error('мастер в сеть не ходит')
      },
      keychain: () => undefined,
    },
    oauth: openOauth(),
    codexOauthHost: {
      codexHome: join(dir, 'codex'),
      fetch: () => {
        throw new Error('мастер в сеть не ходит')
      },
    },
    codexOauth: openCodexOauth(),
  }
}

/** Те же входы записи, что в `index.ts`: `config:set`, `oauth:set`, `startup:set`. */
function depsFor(target: ConfigTarget): FinishDeps {
  return {
    config: () => target.config,
    startupEnabled: () => readStartup(target.startup).enabled,
    changeConfig: (patch) => setConfig(target, patch),
    changeOauth: (provider, enabled) => setOauth(target, provider, enabled),
    changeStartup: (enabled) => setStartup(target, enabled),
  }
}

const configFile = (): string => join(dir, 'config.json')
const configText = (): string => readFileSync(configFile(), 'utf8')

/** Плоский вид патча: `{ alerts: { warnAtPercent: 1 } }` → `{ 'alerts.warnAtPercent': 1 }`. */
function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { [prefix]: value }
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    Object.assign(out, flatten(inner, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

describe('мастер: конец записывается теми же входами, что и настройки', () => {
  /**
   * Ловит мастера со своим набором значений: «Пропустить» с 92% из макета вместо
   * дефолта 90 — это два разных первых запуска у одного продукта, и жалоба
   * воспроизводится только у одного из них.
   */
  it('«Пропустить» даёт дефолты конфига с одним отличием — setup.completed', () => {
    const target = makeTarget()
    finishSetup(depsFor(target), skipArg())

    expect(JSON.parse(configText())).toEqual({
      ...DEFAULT_CONFIG,
      setup: { completed: true },
    })
    expect(loadConfig(configFile()).config.alerts.dangerAtPercent).toBe(90)
  })

  /**
   * Ловит «Начать», которое при нетронутых значениях пишет что-то своё: файл
   * обязан совпасть с «Пропустить» до байта.
   */
  it('«Начать» с нетронутыми значениями даёт тот же файл байт в байт', () => {
    finishSetup(depsFor(makeTarget()), skipArg())
    const skipped = configText()
    rmSync(configFile())

    const target = makeTarget()
    const report = configReport(target)
    finishSetup(depsFor(target), finishArg(draftFromReport(report), report))

    expect(configText()).toBe(skipped)
    // И не трогает систему: нетронутый автозапуск не пишется в «Объекты входа».
    expect(hosts.at(-1)!.writes).toBe(0)
    expect(readStartup(hosts.at(-1)!).enabled).toBe(false)
  })

  /** Ловит потерянное значение: выбранное в мастере обязано оказаться в файле. */
  it('«Начать» пишет выбранное: поля — в конфиг, автозапуск — в систему', () => {
    const target = makeTarget()
    const report = configReport(target)
    const draft = {
      ...draftFromReport(report),
      warnAtPercent: 60,
      dangerAtPercent: 80,
      notifyOnDone: true,
      hidePrompts: true,
      theme: 'dark' as const,
      claudeApi: true,
      updatesAuto: false,
      startup: true,
    }
    finishSetup(depsFor(target), finishArg(draft, report))

    const saved = JSON.parse(configText()) as Config
    expect(saved.alerts).toMatchObject({ warnAtPercent: 60, dangerAtPercent: 80, notifyOnDone: true })
    expect(saved.privacy.hidePrompts).toBe(true)
    expect(saved.ui.theme).toBe('dark')
    expect(saved.limits.claude.api.enabled).toBe(true)
    expect(saved.limits.codex.api.enabled).toBe(false)
    expect(saved.updates.auto).toBe(false)
    expect(saved.setup.completed).toBe(true)
    // Через `readStartup`, а не поле подделки: на Linux автозапуск — файл XDG.
    expect(readStartup(target.startup).enabled).toBe(true)
  })

  /**
   * Ловит согласие на сеть, записанное мимо `oauth:set`: выключение там стирает
   * накопленный ответ, и экран иначе показывал бы проценты под выключенным
   * тумблером — как будто приложение всё ещё ходит в сеть.
   */
  it('выключенное в мастере согласие стирает накопленный ответ провайдера', () => {
    const target = makeTarget()
    setOauth(target, 'claude', true)
    target.oauth.fetchedAt = Date.now()
    const report = configReport(target)
    const draft = { ...draftFromReport(report), claudeApi: false }

    finishSetup(depsFor(target), finishArg(draft, report))

    expect(target.config.limits.claude.api.enabled).toBe(false)
    expect(target.oauth.fetchedAt).toBeUndefined()
  })

  /** Ловит флаг, который окно может выставить само: `setup.completed` ставит только main. */
  it('присланный окном ключ setup отбрасывается', () => {
    const target = makeTarget()
    finishSetup(depsFor(target), { patch: { setup: { completed: false } } })
    expect(target.config.setup.completed).toBe(true)
  })

  /**
   * Ловит канал, которым окно мастера пишет что угодно: `setup:finish` берёт из
   * патча только пути мастера, а каталоги логов и прочее отбрасывает.
   */
  it('поля вне списка мастера каналом setup:finish не пишутся', () => {
    const target = makeTarget()
    finishSetup(depsFor(target), {
      patch: {
        sources: { claudeHome: '/чужой/каталог' },
        live: { pollMs: 5 },
        alerts: { warnAtPercent: 60, sessionTokenAlert: 1 },
      } as never,
    })
    expect(target.config.sources.claudeHome).toBe(DEFAULT_CONFIG.sources.claudeHome)
    expect(target.config.live.pollMs).toBe(DEFAULT_CONFIG.live.pollMs)
    expect(target.config.alerts.sessionTokenAlert).toBe(DEFAULT_CONFIG.alerts.sessionTokenAlert)
    expect(target.config.alerts.warnAtPercent).toBe(60)
  })

  /** Ловит порядок порогов, который загрузчик откатил бы парой — и «Начать» потеряло бы оба. */
  it('пороги в черновике держатся парой: предупреждение не выше тревоги', () => {
    const report = configReport(makeTarget())
    let state = initialSetupState(report)
    state = setupReducer(state, { type: 'draft', patch: { warnAtPercent: 95 } })
    expect(state.draft.warnAtPercent).toBe(90)
    state = setupReducer(state, { type: 'draft', patch: { dangerAtPercent: 50 } })
    expect(state.draft.dangerAtPercent).toBe(90)
    state = setupReducer(state, { type: 'draft', patch: { dangerAtPercent: 95 } })
    state = setupReducer(state, { type: 'draft', patch: { warnAtPercent: 92 } })
    expect(state.draft).toMatchObject({ warnAtPercent: 92, dangerAtPercent: 95 })
  })
})

describe('мастер: контролы и «Настройки»', () => {
  interface Props {
    children?: ReactNode
    onClick?: () => void
    onChange?: (event: { currentTarget: { value: string; checked: boolean } }) => void
    'data-setting'?: string
    'data-theme-choice'?: string
  }

  /**
   * Дерево с раскрытыми компонентами: `Switch` и `Threshold` — чистые функции,
   * а обход по `children` до их разметки не добирается. Тот же приём, что в
   * `settings-screen.test.tsx`.
   */
  function elements(node: ReactNode): Array<ReactElement<Props>> {
    if (!isValidElement(node)) return []
    const element = node as ReactElement<Props>
    const inner =
      typeof element.type === 'function'
        ? elements((element.type as (props: Props) => ReactNode)(element.props))
        : []
    return [
      element,
      ...Children.toArray(element.props.children).flatMap((child) => elements(child)),
      ...inner,
    ]
  }

  function findControl(
    tree: Array<ReactElement<Props>>,
    attr: 'data-setting' | 'data-theme-choice',
    value: string,
  ): ReactElement<Props> | undefined {
    return tree.find((element) => element.props[attr] === value)
  }

  /** Ручка срабатывает так, как её дёрнул бы человек: ползунок — числом, тумблер — флагом. */
  function fire(control: ReactElement<Props>, checked = true): void {
    if (control.props.onClick !== undefined) {
      control.props.onClick()
      return
    }
    control.props.onChange!({ currentTarget: { value: '40', checked } })
  }

  const report = (): ConfigReport => configReport(makeTarget())

  function wizardTree(draft: SetupDraft, onDraft: (patch: Partial<SetupDraft>) => void) {
    const current = report()
    return [
      ...elements(SetupStepThresholds({ draft, onDraft })),
      ...elements(
        SetupStepBehavior({
          draft,
          onDraft,
          startup: current.startup,
          updatesSupported: true,
          scan: null,
          snapshotKnown: false,
          indexing: undefined,
        }),
      ),
    ]
  }

  /** Все ручки раздела «Настройки», которых касается мастер. */
  function settingsTree(recorder: {
    onChange: (patch: object) => void
    onApiToggle: (provider: string, enabled: boolean) => void
    onToggleStartup: (enabled: boolean) => void
  }) {
    const current = report()
    return [
      ...elements(SettingsAlerts({ config: current.config, onChange: recorder.onChange })),
      ...elements(SettingsPrivacy({ config: current.config, onChange: recorder.onChange })),
      ...elements(SettingsAppearance({ config: current.config, onChange: recorder.onChange })),
      ...elements(
        SettingsUsage({
          api: current.usageApi,
          codexApi: current.codexApi,
          onApiToggle: recorder.onApiToggle,
          onApiRefresh: () => undefined,
        }),
      ),
      ...elements(
        SettingsApp({
          config: current.config,
          startup: current.startup,
          update: current.update,
          onChange: recorder.onChange,
          onToggleStartup: recorder.onToggleStartup,
          onCheckUpdate: () => undefined,
          onInstallUpdate: () => undefined,
        }),
      ),
    ]
  }

  /**
   * Ловит контрол мастера, у которого нет пары в «Настройках»: его значение
   * потом нигде не изменить, а мастер превращается во второй набор настроек.
   * Идёт по списку полей — и с обеих сторон дёргает ручку вживую.
   */
  for (const field of SETUP_FIELDS) {
    it(`${field.path}: ручка мастера и ручка «Настроек» пишут одно поле`, () => {
      const [attr, value] = field.control

      // Сторона мастера: щелчок меняет ровно это поле черновика.
      const drafts: Array<Partial<SetupDraft>> = []
      const base = draftFromReport(report())
      const control = findControl(wizardTree(base, (patch) => drafts.push(patch)), attr, value)
      expect(control, `в мастере нет ручки ${attr}=${value}`).toBeDefined()
      // Тумблер щёлкают в обратную сторону от текущего: на дефолтной стороне
      // «изменение» ничего не меняло бы, и проверка молчала бы вхолостую.
      const current = base[field.draft]
      const flip = typeof current === 'boolean' ? !current : true
      fire(control!, flip)
      expect(Object.keys(drafts.at(-1) ?? {})).toEqual([field.draft])

      // Что уезжает из мастера: на этом поле патч меняется, а на остальных — нет.
      const changed = { ...base, ...drafts.at(-1) }
      const before = flatten(setupPatch(base))
      const after = flatten(setupPatch(changed))
      const moved = Object.keys(after).filter((key) => after[key] !== before[key])
      if (field.path === 'startup') {
        expect(moved).toEqual([])
        expect(finishArg(changed, report()).startup).toBeDefined()
      } else {
        expect(moved).toEqual([field.path])
      }

      // Сторона «Настроек»: ручка с тем же именем пишет тот же путь тем же входом.
      const written: Array<Record<string, unknown>> = []
      const toggled: Array<[string, boolean]> = []
      const startups: boolean[] = []
      const settings = settingsTree({
        onChange: (patch) => written.push(flatten(patch)),
        onApiToggle: (provider, enabled) => toggled.push([provider, enabled]),
        onToggleStartup: (enabled) => startups.push(enabled),
      })
      const twin = findControl(settings, attr, value)
      expect(twin, `в «Настройках» нет ручки ${attr}=${value} — контрол мастера без пары`).toBeDefined()
      fire(twin!)
      if (field.via === 'config:set') {
        expect(Object.keys(written.at(-1) ?? {})).toEqual([field.path])
      } else if (field.via === 'oauth:set') {
        const provider = field.path.split('.')[1]
        expect(toggled.at(-1)?.[0]).toBe(provider)
      } else {
        expect(startups).toHaveLength(1)
      }
    })
  }

  /**
   * Ловит ручку, поставленную в мастер мимо списка: список пар — единственное
   * место, где контрол получает право на существование.
   */
  it('в шагах нет ручек, которых нет в списке полей', () => {
    const tree = wizardTree(draftFromReport(report()), () => undefined)
    const seen = new Set<string>()
    for (const element of tree) {
      const setting = element.props['data-setting']
      const theme = element.props['data-theme-choice']
      if (setting !== undefined) seen.add(`data-setting=${setting}`)
      if (theme !== undefined) seen.add('data-theme-choice')
    }
    const listed = new Set(
      SETUP_FIELDS.map(({ control: [attr, value] }) =>
        attr === 'data-theme-choice' ? 'data-theme-choice' : `${attr}=${value}`,
      ),
    )
    expect([...seen].sort()).toEqual([...listed].sort())
  })

  /** Ловит поле в патче, которого нет в списке: патч и список обязаны совпадать. */
  it('патч мастера состоит ровно из полей списка', () => {
    const paths = Object.keys(flatten(setupPatch(draftFromReport(report())))).sort()
    expect(paths).toEqual(
      SETUP_FIELDS.filter((field) => field.path !== 'startup')
        .map((field) => field.path)
        .sort(),
    )
    // Каждый путь существует в конфиге: опечатка в пути молча ничего не писала бы.
    for (const path of paths) {
      let node: unknown = DEFAULT_CONFIG
      for (const key of path.split('.')) node = (node as Record<string, unknown>)[key]
      expect(node, path).toBeDefined()
    }
    // И main пишет каналом `setup:finish` ровно эти пути: новое поле мастера,
    // не внесённое туда, молча не записалось бы.
    expect([...SETUP_CONFIG_PATHS].sort()).toEqual(paths)
  })

  /**
   * Ловит запись «по щелчку»: пока человек листает шаги, конфиг не должен
   * меняться, и «Пропустить» обязано оставлять его как был. Единственный вызов,
   * меняющий состояние, у страницы мастера — `setup:finish`.
   */
  it('страница мастера не зовёт каналов записи, кроме setup:finish', () => {
    const files = readdirSync(join(rendererDir, 'components'))
      .filter((name) => name.startsWith('Setup') && name.endsWith('.tsx'))
      .map((name) => join(rendererDir, 'components', name))
    files.push(join(rendererDir, 'setup-main.tsx'))
    expect(files.length).toBeGreaterThan(6)
    for (const file of files) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
      for (const channel of ['config:set', 'startup:set', 'oauth:set', 'oauth:refresh', 'update:check']) {
        expect(code, `${file}: ${channel}`).not.toContain(channel)
      }
    }
  })

  it('редьюсер шаги не пишет: он меняет номер шага и черновик', () => {
    const start = initialSetupState(report())
    expect(setupReducer(start, { type: 'back' }).step).toBe(1)
    expect(setupReducer(setupReducer(start, { type: 'next' }), { type: 'next' }).step).toBe(3)
    const last = setupReducer(setupReducer(setupReducer(start, { type: 'next' }), { type: 'next' }), {
      type: 'next',
    })
    expect(last.step).toBe(3)
  })
})

describe('мастер: найденное на диске', () => {
  /** Домашние каталоги провайдеров во временной папке: настоящие `~/.claude` не читаются. */
  function homes() {
    const claudeHome = join(dir, 'claude-home')
    const codexHome = join(dir, 'codex-home')
    return { claudeHome, codexHome }
  }

  function seedClaude(claudeHome: string): number {
    const projects = join(claudeHome, 'projects', 'demo')
    mkdirSync(projects, { recursive: true })
    const target = join(projects, '11111111-1111-4111-8111-111111111111.jsonl')
    copyFileSync(join(root, 'fixtures/claude/plain.jsonl'), target)
    const other = join(projects, '22222222-2222-4222-8222-222222222222.jsonl')
    copyFileSync(join(root, 'fixtures/claude/mcp.jsonl'), other)
    return (
      readFileSync(target).byteLength + readFileSync(other).byteLength
    )
  }

  function configWith(paths: { claudeHome: string; codexHome: string }): Config {
    const config = structuredClone(DEFAULT_CONFIG)
    config.sources.claudeHome = paths.claudeHome
    config.sources.codexHome = paths.codexHome
    return config
  }

  /**
   * Ловит `ConfigReport.sources` вместо обхода диска: он считается из индекса и
   * до первого прохода даёт нули — мастер показал бы «логи не найдены» над
   * каталогом с сотнями файлов.
   */
  it('файлы и байты — с диска, ещё до индексации; моделей пока нет', () => {
    const paths = homes()
    const bytes = seedClaude(paths.claudeHome)

    const scan = scanSetup(db, configWith(paths))
    const claude = scan.providers.find((p) => p.provider === 'claude')!
    const codex = scan.providers.find((p) => p.provider === 'codex')!

    expect(claude).toMatchObject({ found: true, files: 2, bytes, models: [] })
    expect(claude.path).toBe(join(paths.claudeHome, 'projects'))
    // Ненайденный провайдер называет, где искал, — серая карточка, а не пустота.
    expect(codex).toMatchObject({ found: false, files: 0, bytes: 0, models: [] })
    expect(codex.path).toBe(join(paths.codexHome, 'sessions'))
  })

  /**
   * Ловит модели, зашитые списком: чипы рисуются по тому, что встретилось в
   * разобранных логах. Две модели из двух разных файлов, обе — не из списка в
   * коде.
   */
  it('модели — из индекса, по провайдерам и без повторов', () => {
    const paths = homes()
    seedClaude(paths.claudeHome)
    const config = configWith(paths)
    ingestAll(db, { claudeHome: paths.claudeHome, codexHome: paths.codexHome })

    const scan = scanSetup(db, config)

    expect(scan.providers.find((p) => p.provider === 'claude')!.models).toEqual([
      'claude-fable-5',
      'claude-opus-5',
    ])
    expect(scan.providers.find((p) => p.provider === 'codex')!.models).toEqual([])
  })

  it('исчезнувший между обходом и stat файл не роняет обход', () => {
    const paths = homes()
    seedClaude(paths.claudeHome)
    rmSync(join(paths.claudeHome, 'projects', 'demo', '22222222-2222-4222-8222-222222222222.jsonl'))
    expect(scanSetup(db, configWith(paths)).providers[0]!.files).toBe(1)
  })

  /** Ловит перечитывание на каждый тик: обход каталога не бесплатен. */
  it('перечитывается, пока проход идёт и сдвинулся, но не чаще порога; и ещё раз в конце', () => {
    const progress = (filesDone: number): IndexProgress => ({
      phase: 'parsing',
      filesDone,
      filesTotal: 10,
      bytesDone: filesDone,
      bytesTotal: 10,
      etaMs: null,
    })
    expect(shouldRescan(progress(1), progress(2), RESCAN_EVERY_MS - 1)).toBe(false)
    expect(shouldRescan(progress(1), progress(2), RESCAN_EVERY_MS)).toBe(true)
    expect(shouldRescan(progress(2), progress(2), RESCAN_EVERY_MS * 10)).toBe(false)
    // Проход кончился: последний кусок событием не объявляется — о конце
    // говорит исчезнувший `indexing`, и модели надо добрать именно тогда.
    expect(shouldRescan(progress(9), undefined, 0)).toBe(true)
    expect(shouldRescan(undefined, undefined, RESCAN_EVERY_MS * 10)).toBe(false)
  })
})

describe('мастер: экраны', () => {
  const scan: SetupScan = {
    providers: [
      {
        provider: 'claude',
        path: '/home/u/.claude/projects',
        found: true,
        files: 412,
        bytes: 597_688_320,
        models: ['zz-model-alpha', 'zz-model-beta'],
      },
      {
        provider: 'codex',
        path: '/home/u/.codex/sessions',
        found: false,
        files: 0,
        bytes: 0,
        models: [],
      },
    ],
  }

  /** Ловит чипы из макета (Opus 5, Sonnet 4.5, gpt-5-codex), зашитые в разметку. */
  it('чипы моделей рисуются по присланному, а не по списку в коде', () => {
    const html = renderToStaticMarkup(<SetupStepSources scan={scan} />)

    expect(html).toContain('data-setup-model="zz-model-alpha"')
    expect(html).toContain('data-setup-model="zz-model-beta"')
    for (const fromMockup of ['Opus 5', 'Sonnet 4.5', 'Haiku 4.5', 'gpt-5-codex', 'gpt-5-mini']) {
      expect(html).not.toContain(fromMockup)
    }
  })

  it('найденный провайдер — зелёная строка с путём, файлами и размером', () => {
    const html = renderToStaticMarkup(<SetupStepSources scan={scan} />)

    expect(html).toContain('✓ /home/u/.claude/projects · 412 файлов · 570.0 МБ')
    expect(html).toContain('data-setup-provider="claude"')
    expect(html).toContain('Agentmeter нашёл логи на этой машине')
  })

  /** Ловит ненайденный провайдер без пути: человек должен видеть, где искали. */
  it('ненайденный провайдер — серая карточка с путём, где искали', () => {
    const html = renderToStaticMarkup(<SetupStepSources scan={scan} />)

    expect(html).toContain('data-setup-found="false"')
    expect(html).toContain('логи не найдены в /home/u/.codex/sessions')
  })

  /** Ловит пустую строку на месте моделей: пустое читалось бы как «моделей нет». */
  it('пока проход не дошёл до запросов — слова, а не пустота', () => {
    const empty: SetupScan = {
      providers: [{ ...scan.providers[0]!, models: [] }, scan.providers[1]!],
    }
    const html = renderToStaticMarkup(<SetupStepSources scan={empty} />)
    expect(html).toContain('модели появятся после чтения логов')
  })

  it('до ответа setup:scan карточек нет — «не найдено» до поиска было бы враньём', () => {
    const html = renderToStaticMarkup(<SetupStepSources scan={null} />)
    expect(html).not.toContain('data-setup-provider')
    expect(html).not.toContain('логи не найдены')
  })

  it('нигде не нашлось — подзаголовок говорит это словами', () => {
    const none: SetupScan = {
      providers: scan.providers.map((p) => ({ ...p, found: false, files: 0, bytes: 0, models: [] })),
    }
    expect(renderToStaticMarkup(<SetupStepSources scan={none} />)).toContain('Логов пока нет')
  })

  it('карточка помещает не больше восьми чипов и прячет остаток за «+N»', () => {
    const many = { ...scan.providers[0]!, models: Array.from({ length: 11 }, (_, i) => `m-${i}`) }
    const html = renderToStaticMarkup(<SetupProviderCard scan={many} />)
    expect(html.match(/data-setup-model=/g)).toHaveLength(8)
    expect(html).toContain('+3')
  })

  function behavior(over: Partial<Parameters<typeof SetupStepBehavior>[0]>): string {
    const current = configReport(makeTarget())
    return renderToStaticMarkup(
      <SetupStepBehavior
        draft={draftFromReport(current)}
        onDraft={() => undefined}
        startup={current.startup}
        updatesSupported
        scan={scan}
        snapshotKnown
        indexing={undefined}
        {...over}
      />,
    )
  }

  const reading = (etaMs: number | null): IndexProgress => ({
    phase: 'parsing',
    filesDone: 100,
    filesTotal: 500,
    bytesDone: 359 * 1024 * 1024,
    bytesTotal: 570 * 1024 * 1024,
    etaMs,
  })

  /** Ловит «0 с» там, где оценки ещё нет: честнее слов. */
  it('пока оценки времени нет — «оцениваем…», а не «0 с»', () => {
    const html = behavior({ indexing: reading(null) })
    expect(html).toContain('читаем логи: 63% · оцениваем…')
    expect(html).not.toContain('0 с')
  })

  it('оценка приезжает готовой и помечена знаком ≈', () => {
    expect(behavior({ indexing: reading(40_000) })).toContain('читаем логи: 63% · ≈ 40 с')
  })

  it('проход закончился — «история готова»; объём логов — с диска', () => {
    const html = behavior({ indexing: undefined })
    expect(html).toContain('логи прочитаны — история готова')
    expect(html).toContain('570.0 МБ логов · 412 файлов')
  })

  it('снимка ещё нет — «оцениваем…», не «готово»', () => {
    expect(behavior({ snapshotKnown: false })).toContain('оцениваем…')
    expect(setupProgress(scan, false, undefined)).toEqual({ kind: 'unknown' })
    expect(setupProgress(null, true, undefined)).toEqual({ kind: 'unknown' })
  })

  it('логов нет совсем — про проход ни слова', () => {
    const none: SetupScan = { providers: scan.providers.map((p) => ({ ...p, files: 0, bytes: 0, found: false })) }
    const html = behavior({ scan: none })
    expect(html).toContain('читать пока нечего')
    expect(html).not.toContain('data-setup-progress-line')
  })

  /** Ловит обещание «в сеть единственный раз»: с 6.3 вызовов три, и тумблера на каждый. */
  it('шаг 3 даёт три тумблера сети вместо ложного подзаголовка', () => {
    const html = behavior({})
    for (const name of ['oauth', 'codex-oauth', 'updatesAuto']) {
      expect(html).toContain(`data-setting="${name}"`)
    }
    expect(html).not.toContain('единственный раз')
    // Снятое из макета не возвращается.
    for (const gone of ['проценты прямо в трее', 'Собрать историю', 'Дорогая сессия', 'Переплата за паузу']) {
      expect(html).not.toContain(gone)
    }
  })

  it('рама: на последнем шаге «Начать», на остальных «Далее»; два языка', () => {
    const noop = () => undefined
    const page = (step: 1 | 2 | 3) =>
      renderToStaticMarkup(
        <SetupFrame step={step} onSkip={noop} onBack={noop} onNext={noop} onStart={noop}>
          <div />
        </SetupFrame>,
      )
    expect(page(1)).toContain('data-setup-action="next"')
    expect(page(1)).toContain('шаг 1 из 3')
    expect(page(3)).toContain('data-setup-action="start"')
    expect(page(3)).toContain('Начать')
    expect(page(3)).toContain('пропустить настройку')
    setLocale('en')
    expect(page(3)).toContain('Skip setup')
    expect(page(2)).toContain('step 2 of 3')
  })

  it('мастер открывается на шаге 1 с текущими значениями конфига', () => {
    const html = renderToStaticMarkup(
      <SetupWizard
        report={configReport(makeTarget())}
        scan={scan}
        snapshotKnown
        indexing={undefined}
        onFinish={() => undefined}
      />,
    )
    expect(html).toContain('data-setup-step="1"')
    expect(html).not.toContain('data-setup-step="2"')
  })

  it('кнопка «Открыть мастер» есть в разделе «Приложение» и зовёт открытие', () => {
    const open = vi.fn()
    const current = configReport(makeTarget())
    const tree = elements2(
      SettingsApp({
        config: current.config,
        startup: current.startup,
        update: current.update,
        onChange: () => undefined,
        onToggleStartup: () => undefined,
        onCheckUpdate: () => undefined,
        onInstallUpdate: () => undefined,
        onOpenSetup: open,
      }),
    )
    const button = tree.find((el) => (el.props as Record<string, unknown>)['data-setup-action'] === 'open')
    expect(button).toBeDefined()
    ;(button!.props as { onClick: () => void }).onClick()
    expect(open).toHaveBeenCalledTimes(1)
  })

  function elements2(node: ReactNode): ReactElement[] {
    if (!isValidElement(node)) return []
    const element = node as ReactElement<{ children?: ReactNode }>
    return [element, ...Children.toArray(element.props.children).flatMap((c) => elements2(c))]
  }
})

describe('мастер: порядок показа', () => {
  /** Окно-подделка: ведёт себя как `BrowserWindow` в части, нужной порядку показа. */
  class FakeWindow extends EventEmitter implements SetupWindowLike {
    destroyed = false
    minimized = false
    shows = 0
    isDestroyed = () => this.destroyed
    isMinimized = () => this.minimized
    restore = () => {
      this.minimized = false
    }
    show = () => {
      this.shows += 1
    }
    focus = () => undefined
    close = () => {
      this.destroyed = true
      this.emit('closed')
    }
  }

  function harness(startCompleted = false) {
    const target = makeTarget()
    target.config.setup.completed = startCompleted
    const windows: FakeWindow[] = []
    const calls = { finish: [] as unknown[], afterFirstRun: 0 }
    let quitting = false
    const deps: SetupFlowDeps = {
      due: () => setupDue(target.config),
      quitting: () => quitting,
      create: () => {
        const window = new FakeWindow()
        windows.push(window)
        return window
      },
      finish: (arg) => {
        calls.finish.push(arg)
        return finishSetup(depsFor(target), arg)
      },
      afterFirstRun: () => {
        calls.afterFirstRun += 1
      },
    }
    return { flow: createSetupFlow(deps), target, windows, calls, quit: () => (quitting = true) }
  }

  it('первый запуск показывает мастер, второй — нет, но setup:open открывает', () => {
    const { flow, windows, target } = harness(false)
    expect(flow.showIfDue()).toBe(true)
    expect(windows).toHaveLength(1)

    flow.finish({ patch: {} })
    expect(target.config.setup.completed).toBe(true)
    // Файл на диске тоже говорит «пройден»: следующий запуск прочтёт его.
    expect(loadConfig(configFile()).config.setup.completed).toBe(true)

    expect(flow.showIfDue()).toBe(false)
    expect(windows).toHaveLength(1)
    flow.open()
    expect(windows).toHaveLength(2)
  })

  it('канал setup:open объявлен в контракте', () => {
    expect(IPC_CALLS).toEqual(expect.arrayContaining(['setup:scan', 'setup:open', 'setup:finish']))
  })

  it('второго окна мастера не бывает: повторное открытие поднимает прежнее', () => {
    const { flow, windows } = harness(true)
    flow.open()
    windows[0]!.minimized = true
    flow.open()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.shows).toBe(1)
    expect(windows[0]!.minimized).toBe(false)
  })

  /**
   * Ловит крестик, который ничего не решает: иначе человек, закрывший мастер,
   * видел бы его при каждом запуске. Закрытое окно — «Пропустить»: пустой патч.
   */
  it('закрытое крестиком окно при первом запуске = «Пропустить»', () => {
    const { flow, windows, calls, target } = harness(false)
    flow.showIfDue()

    windows[0]!.close()

    expect(calls.finish).toEqual([{ patch: {} }])
    expect(calls.afterFirstRun).toBe(1)
    expect(target.config.setup.completed).toBe(true)
    expect(JSON.parse(configText())).toEqual({ ...DEFAULT_CONFIG, setup: { completed: true } })
  })

  it('«Начать» закрывает окно один раз и открывает попап', () => {
    const { flow, windows, calls } = harness(false)
    flow.showIfDue()

    flow.finish({ patch: { ui: { theme: 'dark' } } })

    expect(windows[0]!.destroyed).toBe(true)
    // Закрытие окна самой кнопкой — не второй «Пропустить».
    expect(calls.finish).toHaveLength(1)
    expect(calls.afterFirstRun).toBe(1)
  })

  /**
   * Ловит попап, открытый раньше, чем закрылось окно мастера: на macOS закрытие
   * последнего окна прячет док, приложение теряет фокус, и попап закрывается по
   * `blur`, едва открывшись. Настоящее окно закрывается асинхронно.
   */
  it('после «Начать» попап открывается, когда окно мастера уже закрылось', () => {
    const { flow, windows, calls } = harness(false)
    flow.showIfDue()
    const window = windows[0]!
    window.close = () => undefined

    flow.finish({ patch: {} })
    expect(calls.afterFirstRun).toBe(0)

    window.destroyed = true
    window.emit('closed')
    expect(calls.afterFirstRun).toBe(1)
    expect(calls.finish).toHaveLength(1)
  })

  /** Ловит повторно открытый мастер, который «пропускает» то, что уже пройдено. */
  it('повторно открытый мастер, закрытый крестиком, ничего не пишет', () => {
    const { flow, windows, calls } = harness(true)
    flow.open()
    windows[0]!.close()
    expect(calls.finish).toEqual([])
    expect(calls.afterFirstRun).toBe(0)
    expect(existsSync(configFile())).toBe(false)
  })

  /** Ловит выход из приложения, засчитанный как решение: мастер больше не вернулся бы. */
  it('выход из приложения при открытом мастере пропуском не считается', () => {
    const { flow, windows, calls, target, quit } = harness(false)
    flow.showIfDue()

    // `before-quit` ставит флаг раньше, чем окна начнут закрываться.
    quit()
    windows[0]!.close()

    expect(calls.finish).toEqual([])
    expect(target.config.setup.completed).toBe(false)
    expect(existsSync(configFile())).toBe(false)
  })
})

describe('мастер: первый ли это запуск', () => {
  const fresh = () => structuredClone(DEFAULT_CONFIG)

  /** Ловит мастер у того, кто жил одним попапом и файла настроек не завёл. */
  it('нет файла настроек, но индекс был — мастер не показывается и файл не пишется', () => {
    const config = fresh()
    const save = vi.fn()
    settleFirstRun(config, { config: false, index: true }, save)
    expect(setupDue(config)).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })

  /**
   * Ловит мастер, брошенный выходом из приложения: индекс этот запуск уже завёл,
   * и без явного `false` в файле следующий запуск счёл бы человека прежним.
   */
  it('совсем новый человек — мастер показывается, false пишется в файл сразу', () => {
    const config = fresh()
    const save = vi.fn()
    settleFirstRun(config, { config: false, index: false }, save)
    expect(setupDue(config)).toBe(true)
    expect(save).toHaveBeenCalledWith(config)
  })

  it('файл настроек был — решает он, а не индекс', () => {
    const config = fresh()
    const save = vi.fn()
    settleFirstRun(config, { config: true, index: true }, save)
    expect(setupDue(config)).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('мастер: индекс не ждёт окна', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
    'utf8',
  )

  /**
   * Ловит мастера, поднятого до прохода: закрытое окно стоило бы человеку
   * потерянной индексации, а трей молчал бы, пока он читает три шага. Порядок
   * проверяется по тексту `main()`, потому что запустить его без Electron нечем;
   * живую половину — окно поднимается и страница грузится — держит смоук.
   */
  it('проход запускается раньше, чем показывается мастер', () => {
    const drive = source.search(/driveIngest\(runtime, \(progress\)/)
    const show = source.search(/setupFlow\.showIfDue\(\)/)
    expect(drive).toBeGreaterThan(0)
    expect(show).toBeGreaterThan(drive)
  })

  it('openRuntime откладывает проход и не знает про мастер', () => {
    const body = source.slice(source.indexOf('function openRuntime('), source.indexOf('function startWatcher('))
    expect(body).not.toMatch(/setup/i)
    expect(source).toContain('openRuntime(true, true)')
  })
})
