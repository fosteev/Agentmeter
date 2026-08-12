import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  loadConfig,
  openDb,
  setLocale,
  t,
  type Config,
  type Db,
} from '@agentmeter/core'
import { configReport, setConfig, type ConfigTarget } from '../src/main/config.ts'
import { openJournal, type StatuslineHost } from '../src/main/statusline.ts'
import { openOauth } from '../src/main/oauth.ts'
import { openCodexOauth } from '../src/main/codex-oauth.ts'

/**
 * Настройки в main (3.6): запись на диск и применение без перезапуска.
 *
 * До 3.6 канал `config:set` возвращал `{ problems: [] }` и не делал ничего.
 * Проверки названы поломкой, которую ловят, и каждая описывает случай, в
 * котором приложение соврало бы молча: сохранилось, но не применилось;
 * применилось, но не сохранилось; отвергнуто, но выглядит принятым.
 */

let dir: string
let db: Db
let target: ConfigTarget

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-settings-'))
  // `configPath()` смотрит на эту переменную — иначе тест писал бы в настройки
  // человека, который его запустил.
  process.env['AGENTMETER_HOME'] = dir
  db = openDb(join(dir, 'index.sqlite')).db
  setLocale('ru')
  target = {
    db,
    config: structuredClone(DEFAULT_CONFIG),
    liveOptions: { idleMs: DEFAULT_CONFIG.live.idleMs, claudeLimits: DEFAULT_CONFIG.limits.claude },
    configProblems: [],
    // Электрона в тестах нет, а автозапуск спрашивают у него. Хост подменён
    // объектом с памятью: проверяется поведение — «что система ответила», — а
    // не то, что мы себе записали.
    startup: fakeHost(),
    // Хук строки состояния (1.9) пишет в каталог Claude Code. Здесь он
    // временный: тест, правящий `~/.claude/settings.json` человека, — это не
    // тест, а происшествие.
    statusline: statuslineHost(),
    usage: openJournal(statuslineHost()),
    // Второй источник лимитов (6.3) — с `fetch`, который падает при вызове:
    // отчёт о настройках в сеть не ходит и ходить не должен.
    oauthHost: {
      claudeHome: join(dir, 'claude'),
      platform: 'darwin',
      fetch: () => {
        throw new Error('отчёт о настройках в сеть не ходит')
      },
      keychain: () => undefined,
    },
    oauth: openOauth(),
    // То же для Codex (6.4): падающий `fetch` — это проверка «в сеть не
    // ходили», и она обязана падать, а не молчать.
    codexOauthHost: {
      codexHome: join(dir, 'codex'),
      fetch: () => {
        throw new Error('отчёт о настройках в сеть не ходит')
      },
    },
    codexOauth: openCodexOauth(),
  }
})

function statuslineHost(): StatuslineHost {
  return { claudeHome: join(dir, 'claude'), configDir: dir, platform: 'darwin' }
}

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env['AGENTMETER_HOME']
})

/** Подделка `app`: помнит, что ей записали, и отвечает этим на вопрос. */
function fakeHost(packaged = true): ConfigTarget['startup'] & { openAtLogin: boolean } {
  return {
    isPackaged: packaged,
    openAtLogin: false,
    getLoginItemSettings() {
      return { openAtLogin: this.openAtLogin }
    },
    setLoginItemSettings(settings: { openAtLogin: boolean }) {
      this.openAtLogin = settings.openAtLogin
    },
  }
}

function saved(): Config {
  return loadConfig(join(dir, 'config.json')).config
}

describe('настройки в main', () => {
  /**
   * Ловит правку, которая живёт только в памяти: до 3.6 канал именно так себя
   * и вёл — интерфейс переключался, а следующий запуск возвращал прежнее.
   */
  it('правка доезжает до файла на диске', () => {
    expect(existsSync(join(dir, 'config.json'))).toBe(false)

    setConfig(target, { ui: { theme: 'dark' } })

    expect(saved().ui.theme).toBe('dark')
    expect(target.config.ui.theme).toBe('dark')
  })

  /**
   * Ловит запись, затирающую соседние настройки: правка приходит кусочком, и
   * всё, чего в ней нет, обязано пережить сохранение.
   */
  it('соседние настройки переживают правку', () => {
    setConfig(target, { alerts: { warnAtPercent: 60 } })
    setConfig(target, { ui: { locale: 'en' } })

    const config = saved()
    expect(config.alerts.warnAtPercent).toBe(60)
    expect(config.ui.locale).toBe('en')
    expect(config.privacy.hidePrompts).toBe(false)
  })

  /**
   * Ловит порог, сохранённый мимо живого слоя. Слой держит **тот самый**
   * объект настроек и читает его на каждом снимке; подмени его копией — и
   * новое значение оказалось бы в файле, но не в поведении.
   */
  it('пороги живого слоя применяются без перезапуска', () => {
    setConfig(target, { live: { idleMs: 30_000 } })

    expect(target.liveOptions.idleMs).toBe(30_000)
  })

  /** Ловит потолки лимитов, не доехавшие до пересборки окон. */
  it('потолки лимитов доезжают до живого слоя', () => {
    setConfig(target, { limits: { claude: { plan: 'Max 5×', fiveHourCap: 88_000 } } })

    expect(target.liveOptions.claudeLimits?.fiveHourCap).toBe(88_000)
    expect(saved().limits.claude.plan).toBe('Max 5×')
  })

  /**
   * Ловит непринятое значение, выданное за принятое: отчёт обязан назвать
   * причину, а на диск и в память должно лечь прежнее.
   */
  it('непонятая правка не сохраняется и названа в отчёте', () => {
    const report = setConfig(target, { ui: { theme: 'chartreuse' } } as never)

    expect(report.config.ui.theme).toBe('system')
    expect(saved().ui.theme).toBe('system')
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toContain('ui.theme')
  })

  /**
   * Ловит бодрую цифру над несуществующим каталогом: индекс помнит вчерашний
   * том, а `readable` спрашивает диск сегодня.
   */
  it('отчёт различает прочитанный источник и пропавший каталог', () => {
    setConfig(target, { sources: { claudeHome: join(dir, 'нет-такого') } })

    const report = configReport(target)
    const claude = report.sources.find((source) => source.provider === 'claude')

    expect(claude?.readable).toBe(false)
    expect(claude?.path).toBe(join(dir, 'нет-такого'))
    expect(report.sources).toHaveLength(2)
  })

  /**
   * Ловит счётчик файлов, посчитанный обходом каталога вместо индекса: на
   * экране настроек обязано стоять то, что приложение **прочитало**, а не то,
   * что лежит на диске.
   */
  it('число файлов и байт берётся из индекса', () => {
    db.run(
      `INSERT INTO sources (path, provider, inode, size, mtime, offset, parsed_at)
       VALUES ('/a.jsonl', 'claude', 1, 2048, 0, 0, 0), ('/b.jsonl', 'claude', 2, 1024, 0, 0, 0),
              ('/c.jsonl', 'codex', 3, 512, 0, 0, 0)`,
    )

    const sources = configReport(target).sources
    const claude = sources.find((source) => source.provider === 'claude')
    const codex = sources.find((source) => source.provider === 'codex')

    expect(claude).toMatchObject({ files: 2, bytes: 3072 })
    expect(codex).toMatchObject({ files: 1, bytes: 512 })
  })

  /**
   * Ловит язык, применённый только в окне. Строки main — подсказка трея,
   * оговорки точности, фразы карточки — собираются здесь, и после смены языка
   * они обязаны собираться на новом: иначе шапка окна и подпись под ней
   * окажутся на разных языках.
   */
  it('смена языка применяется к строкам main сразу', () => {
    setConfig(target, { ui: { locale: 'en' } })
    const english = t('state.thinking')
    setConfig(target, { ui: { locale: 'ru' } })
    const russian = t('state.thinking')

    expect(english).not.toBe(russian)
    expect(russian).toMatch(/[А-Яа-я]/)
    expect(english).not.toMatch(/[А-Яа-я]/)
  })
})
