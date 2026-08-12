import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatch, loadConfig, saveConfig } from '../../src/config/load.ts'
import { DEFAULT_CONFIG } from '../../src/config/types.ts'
import { rulePathsInDefaults } from '../../src/config/validate.ts'
import { setLocale } from '../../src/i18n/index.ts'

let dir: string
const path = () => join(dir, 'config.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-cfg-'))
  // Замечания загрузчика с 3.6 переводятся, а язык по умолчанию берётся у
  // системы: без явной установки текст зависел бы от машины, на которой
  // запустили тест.
  setLocale('ru')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('конфиг', () => {
  it('без файла отдаёт дефолты и не жалуется', () => {
    const { config, problems } = loadConfig(path())
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(problems).toEqual([])
  })

  it('частичный конфиг дополняется дефолтами', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { warnAtPercent: 50 } }))
    const { config, problems } = loadConfig(path())
    expect(config.alerts.warnAtPercent).toBe(50)
    expect(config.alerts.dangerAtPercent).toBe(DEFAULT_CONFIG.alerts.dangerAtPercent)
    expect(problems).toEqual([])
  })

  it('вес чтения кэша по умолчанию не выдуман, а не задан', () => {
    const { config } = loadConfig(path())
    expect(config.limits.claude.cacheReadWeight).toBeNull()
  })

  it('поле не того типа заменяется дефолтом и попадает в список проблем', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { warnAtPercent: 'много' } }))
    const { config, problems } = loadConfig(path())
    expect(config.alerts.warnAtPercent).toBe(DEFAULT_CONFIG.alerts.warnAtPercent)
    expect(problems).toEqual([
      'alerts.warnAtPercent: ожидалось число, пришло строка — взят дефолт',
    ])
  })

  it('битый JSON не роняет загрузку, но и не замалчивается', () => {
    writeFileSync(path(), '{ это не json')
    const { config, problems } = loadConfig(path())
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('не разбирается как JSON')
  })

  it('неизвестные ключи не мешают: конфиг мог написать более новый выпуск', () => {
    writeFileSync(path(), JSON.stringify({ somethingNew: { a: 1 }, ui: { theme: 'dark' } }))
    const { config, problems } = loadConfig(path())
    expect(config.ui.theme).toBe('dark')
    expect(problems).toEqual([])
  })

  /**
   * Ловит дыру, с которой этап 3.6 начался: до него проверялся только тип, и
   * `"theme": "chartreuse"` проходило молча — обе строки строки. Настройка,
   * которой нет, доезжала до интерфейса и там ничего не делала, а шапка
   * `load.ts` обещала обратное.
   */
  it('значение не из списка заменяется дефолтом, а не принимается как строка', () => {
    writeFileSync(path(), JSON.stringify({ ui: { theme: 'chartreuse', locale: 'de' } }))
    const { config, problems } = loadConfig(path())

    expect(config.ui.theme).toBe(DEFAULT_CONFIG.ui.theme)
    expect(config.ui.locale).toBe(DEFAULT_CONFIG.ui.locale)
    expect(problems).toEqual([
      'ui.theme: допустимо system | light | dark, пришло "chartreuse" — взят дефолт',
      'ui.locale: допустимо system | ru | en, пришло "de" — взят дефолт',
    ])
  })

  /** Ловит число нужного типа, но бессмысленное: часа 47 в сутках нет. */
  it('число вне диапазона заменяется дефолтом', () => {
    writeFileSync(path(), JSON.stringify({ ui: { dayStartsAtHour: 47 }, live: { pollMs: 0 } }))
    const { config, problems } = loadConfig(path())

    expect(config.ui.dayStartsAtHour).toBe(DEFAULT_CONFIG.ui.dayStartsAtHour)
    expect(config.live.pollMs).toBe(DEFAULT_CONFIG.live.pollMs)
    expect(problems).toHaveLength(2)
  })

  /**
   * Ловит пару порогов, допустимую по отдельности и бессмысленную вместе:
   * предупреждение после тревоги нечем объяснить на экране.
   */
  it('предупреждение выше тревоги откатывает оба порога', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { warnAtPercent: 95, dangerAtPercent: 80 } }))
    const { config, problems } = loadConfig(path())

    expect(config.alerts.warnAtPercent).toBe(DEFAULT_CONFIG.alerts.warnAtPercent)
    expect(config.alerts.dangerAtPercent).toBe(DEFAULT_CONFIG.alerts.dangerAtPercent)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('95')
  })

  /**
   * Ловит правило на пути, которого в конфиге нет: опечатка в `RULES`
   * превращает проверку значения в проверку, которая никогда не срабатывает,
   * — и выглядит она при этом ровно как работающая.
   */
  it('каждое правило стоит на существующем поле конфига', () => {
    expect(rulePathsInDefaults()).toEqual([])
  })

  /**
   * Ловит правку, применённую целым конфигом: канал `config:set` присылает
   * кусочек, и всё, чего в нём нет, обязано остаться прежним. Затри мы конфиг
   * присланным объектом — соседняя настройка, изменённая в это же время,
   * пропала бы молча.
   */
  it('частичная правка меняет только присланное', () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.ui.theme = 'dark'
    current.alerts.warnAtPercent = 60

    const { config, problems } = applyPatch(current, { ui: { locale: 'en' } })

    expect(config.ui.locale).toBe('en')
    expect(config.ui.theme).toBe('dark')
    expect(config.alerts.warnAtPercent).toBe(60)
    expect(problems).toEqual([])
  })

  /**
   * Ловит откат к заводскому значению вместо текущего: отвергнув правку, надо
   * оставить то, что работало, а не то, что было при установке.
   */
  it('непонятая правка откатывается к текущему значению, а не к заводскому', () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.ui.theme = 'dark'

    const { config, problems } = applyPatch(current, { ui: { theme: 'chartreuse' } } as never)

    expect(config.ui.theme).toBe('dark')
    expect(problems).toHaveLength(1)
  })

  /**
   * Ловит тарифные потолки, доехавшие до поля, которое теперь означает
   * измеренное (7.4).
   *
   * Лишние ключи загрузчик игнорирует молча, и `plan` из конфига исчезает сам —
   * а числа под ним остались бы валидными числами и поехали бы дальше как
   * измерение. 220 000 у «Max 20×» — заявленный тариф, которого никто не мерил,
   * и процент от него был бы посчитан от выдуманного знаменателя.
   */
  it('потолки, выбранные планом, сбрасываются и об этом сказано', () => {
    writeFileSync(
      path(),
      JSON.stringify({
        limits: {
          claude: { plan: 'Max 20×', fiveHourCap: 220_000, weeklyCap: 4_400_000, cacheReadWeight: 0.2 },
        },
      }),
    )
    const { config, problems } = loadConfig(path())

    expect(config.limits.claude.fiveHourCap).toBeNull()
    expect(config.limits.claude.weeklyCap).toBeNull()
    // Вес остаётся: его мерила калибровка, а не таблица тарифов.
    expect(config.limits.claude.cacheReadWeight).toBe(0.2)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Max 20×')
  })

  /** Ловит сброс потолков у того, кто плана не выбирал: мерить их заново незачем. */
  it('измеренные потолки без плана остаются на месте', () => {
    writeFileSync(
      path(),
      JSON.stringify({ limits: { claude: { fiveHourCap: 3_900_000, weeklyCap: 48_000_000 } } }),
    )
    const { config, problems } = loadConfig(path())

    expect(config.limits.claude.fiveHourCap).toBe(3_900_000)
    expect(problems).toEqual([])
  })

  it('сохранённый конфиг читается обратно без изменений', () => {
    const cfg = structuredClone(DEFAULT_CONFIG)
    cfg.limits.claude = {
      fiveHourCap: 44_000_000,
      weeklyCap: 480_000_000,
      cacheReadWeight: 0.1,
      api: { enabled: false },
    }
    saveConfig(cfg, path())
    expect(loadConfig(path()).config).toEqual(cfg)
  })
})
