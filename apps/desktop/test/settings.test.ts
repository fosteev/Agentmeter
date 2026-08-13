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
  type Calibration,
  type ClaudeLimits,
  type Config,
  type Db,
} from '@agentmeter/core'
import { calibrationPatch } from '../src/main/calibration.ts'
import { configReport, setConfig, type ConfigTarget } from '../src/main/config.ts'
import { openJournal } from '../src/main/usage.ts'
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
    // Журнал наблюдений (1.9) — во временном каталоге: тест, дописывающий
    // журнал человека, это не тест, а происшествие.
    usage: openJournal({ configDir: dir }),
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

  /**
   * Ловит потолки лимитов, не доехавшие до пересборки окон. Пишет их теперь
   * только калибровка (7.4), но путь до живого слоя у правки тот же.
   */
  it('потолки лимитов доезжают до живого слоя', () => {
    setConfig(target, { limits: { claude: { fiveHourCap: 88_000, cacheReadWeight: 0.2 } } })

    expect(target.liveOptions.claudeLimits?.fiveHourCap).toBe(88_000)
    expect(saved().limits.claude.cacheReadWeight).toBe(0.2)
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

/**
 * Что калибровка 1.9 записывает в настройки (7.4).
 *
 * Единственное место, где измеренное число попадает в конфиг, — и до 7.4 у него
 * было исключение: выбранный план запрещал записать измеренный потолок. Плана
 * больше нет, исключения тоже, и проверка стоит ровно на этом.
 */
describe('запись калибровки', () => {
  const limits = (over: Partial<ClaudeLimits> = {}): ClaudeLimits => ({
    fiveHourCap: null,
    weeklyCap: null,
    cacheReadWeight: null,
    api: { enabled: false },
    ...over,
  })

  const solved = (over: Partial<Calibration> = {}): Calibration =>
    ({
      ok: true,
      cacheReadWeight: 0.2,
      fiveHourCap: 3_900_000,
      weeklyCap: 48_000_000,
      ...over,
    }) as Calibration

  /** Ловит измеренное, не доехавшее до конфига: другого источника у этих чисел нет. */
  it('сошедшаяся калибровка пишет и вес, и оба потолка', () => {
    expect(calibrationPatch(limits(), solved())).toEqual({
      cacheReadWeight: 0.2,
      fiveHourCap: 3_900_000,
      weeklyCap: 48_000_000,
    })
  })

  /**
   * Ловит правдоподобное число, подставленное вместо признания незнания:
   * «данных мало» — нормальный исход, при котором в конфиг не едет ничего.
   *
   * Числа в несошедшейся калибровке намеренно **не** обнулены: по договору типа
   * там `null`, и проверка на нулях прошла бы и без единой строки кода —
   * `differs` не пишет `null` в любом случае. Смотреть надо на решение, а не на
   * его вход.
   */
  it('несошедшаяся не пишет ничего, даже когда числа в ней есть', () => {
    expect(calibrationPatch(limits(), solved({ ok: false }))).toEqual({})
  })

  /** Ловит перезапись тем же значением: она дёргает файл настроек на каждый опрос. */
  it('то же самое второй раз не пишется', () => {
    const current = limits({ cacheReadWeight: 0.2, fiveHourCap: 3_900_000, weeklyCap: 48_000_000 })
    expect(calibrationPatch(current, solved())).toEqual({})
  })

  /**
   * Ловит вернувшуюся оговорку про выбранный план: заявленный тариф — число в
   * других единицах, и перебивать им измеренный потолок нельзя.
   */
  it('прежние потолки перебиваются измеренными, а не наоборот', () => {
    const current = limits({ fiveHourCap: 220_000, weeklyCap: 4_400_000 })
    expect(calibrationPatch(current, solved())).toEqual({
      cacheReadWeight: 0.2,
      fiveHourCap: 3_900_000,
      weeklyCap: 48_000_000,
    })
  })
})
