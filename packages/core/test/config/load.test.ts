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
    expect(config).toEqual({ ...DEFAULT_CONFIG, setup: { completed: true } })
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

  /**
   * Ловит потерю выключенного тумблера при разъезде `notifyOnIdle` надвое (7.8).
   *
   * Лишние ключи загрузчик игнорирует молча, а недостающие берёт из дефолта —
   * то есть без переноса человек, отключивший уведомления об агентах, получил
   * бы их обратно первым же обновлением.
   */
  it('выключенный notifyOnIdle переносится в notifyOnWaiting', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { notifyOnIdle: false } }))
    const { config, problems } = loadConfig(path())

    expect(config.alerts.notifyOnWaiting).toBe(false)
    expect(config.alerts.notifyOnDone).toBe(false)
    expect(problems).toEqual([])
  })

  /** Ловит перенос, включающий уведомление о закрытом чате обратно. */
  it('включённый notifyOnIdle не включает уведомление о завершении', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { notifyOnIdle: true } }))

    expect(loadConfig(path()).config.alerts).toMatchObject({
      notifyOnWaiting: true,
      notifyOnDone: false,
    })
  })

  /**
   * Ловит показ мастера (7.3) каждому, кто обновился: ключа `setup` в старом
   * файле нет, дефолт `false` показал бы окно первичной настройки человеку,
   * который давно пользуется приложением.
   */
  it('существующий конфиг без setup считается прошедшим мастер', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { warnAtPercent: 50 } }))
    const { config, problems } = loadConfig(path())

    expect(config.setup.completed).toBe(true)
    expect(problems).toEqual([])
  })

  it('пустой существующий конфиг тоже считается прошедшим мастер', () => {
    writeFileSync(path(), '{}')
    expect(loadConfig(path()).config.setup.completed).toBe(true)
  })

  /** Ловит обратную поломку: миграция не должна перебивать явное `false`. */
  it('явное setup.completed: false не перебивается миграцией', () => {
    writeFileSync(path(), JSON.stringify({ setup: { completed: false } }))
    expect(loadConfig(path()).config.setup.completed).toBe(false)
  })

  it('без файла мастер ещё не пройден', () => {
    expect(loadConfig(path()).config.setup.completed).toBe(false)
    expect(DEFAULT_CONFIG.setup.completed).toBe(false)
  })

  /**
   * Ловит «первый запуск» у файла с ошибкой: мастер показался бы давнему
   * пользователю, а «Пропустить» записало бы поверх его файла дефолты.
   */
  it('setup.completed не того типа попадает в проблемы, но мастер не показывает', () => {
    writeFileSync(path(), JSON.stringify({ setup: { completed: 'да' } }))
    const { config, problems } = loadConfig(path())

    expect(config.setup.completed).toBe(true)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('setup.completed')
  })

  it('setup не объектом тоже не делает запуск первым', () => {
    writeFileSync(path(), JSON.stringify({ setup: 5 }))
    expect(loadConfig(path()).config.setup.completed).toBe(true)
  })

  it('битый JSON — не первый запуск: файл есть, мастер не показывается', () => {
    writeFileSync(path(), '{ "alerts": { ')
    const { config, problems } = loadConfig(path())

    expect(config.setup.completed).toBe(true)
    expect(problems).toHaveLength(1)
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

/**
 * Раздел `workflow` (9.2).
 *
 * Роли — список объектов, а не скаляров: форма, которой обход конфига раньше не
 * знал. Проверки названы по поломке, которую ловят.
 */
describe('конфиг: workflow', () => {
  const write = (workflow: unknown) => writeFileSync(path(), JSON.stringify({ workflow }))

  it('по умолчанию включён (0.6.1), роли и регулярки — из брифа, цели и пороги не заданы', () => {
    const { config, problems } = loadConfig(path())
    expect(problems).toEqual([])
    const w = config.workflow
    expect(w.enabled).toBe(true)
    expect(w.roles).toEqual([
      { match: 'exec-*', role: 'executor' },
      { match: 'review-*', role: 'reviewer' },
      { match: 'plan-*', role: 'planner' },
      { match: 'Explore', role: 'explore' },
    ])
    expect(w.window).toEqual({ cycles: 10, sessions: 20 })
    expect(w.target).toEqual({ rework: null })
    expect(w.alerts).toEqual({ rework: null, errorRate: null, overhead: null })
  })

  it('дефолтные регулярки компилируются и не совпадают с пустой строкой', () => {
    for (const source of Object.values(DEFAULT_CONFIG.workflow.verdicts)) {
      expect(() => new RegExp(source, 'i')).not.toThrow()
      expect(new RegExp(source, 'i').test('')).toBe(false)
    }
  })

  it('битая регулярка отклоняется с путём ключа, остальные принимаются, main не падает', () => {
    // `false`, а не `true`: с 0.6.1 включено по умолчанию, и `true` здесь
    // прошло бы, даже если бы выбор человека потерялся вместе с регуляркой.
    write({ verdicts: { rejected: '(не закрыта', accepted: 'ОК' }, enabled: false })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.verdicts.rejected).toBe(DEFAULT_CONFIG.workflow.verdicts.rejected)
    expect(config.workflow.verdicts.accepted).toBe('ОК')
    expect(config.workflow.enabled).toBe(false)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('workflow.verdicts.rejected')
    expect(problems[0]).toContain('"(не закрыта"')
  })

  it.each([[''], ['a*'], ['(?:)'], ['x'.repeat(201)]])('регулярка %j отклоняется', (bad) => {
    write({ verdicts: { notes: bad } })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.verdicts.notes).toBe(DEFAULT_CONFIG.workflow.verdicts.notes)
    expect(problems.join('\n')).toContain('workflow.verdicts.notes')
  })

  it('регулярка не строкой отклоняется по типу', () => {
    write({ verdicts: { accepted: 5 } })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.verdicts.accepted).toBe(DEFAULT_CONFIG.workflow.verdicts.accepted)
    expect(problems).toEqual(['workflow.verdicts.accepted: ожидалось строка, пришло число — взят дефолт'])
  })

  it('свои роли заменяют дефолтные целиком и сохраняют порядок', () => {
    const roles = [
      { match: 'general-purpose', role: 'executor' },
      { match: 'exec-*', role: 'reviewer' },
    ]
    write({ roles })
    const { config, problems } = loadConfig(path())
    expect(problems).toEqual([])
    expect(config.workflow.roles).toEqual(roles)
  })

  it('пустой список ролей — законное «ролей нет», а не откат к дефолту', () => {
    write({ roles: [] })
    const { config, problems } = loadConfig(path())
    expect(problems).toEqual([])
    expect(config.workflow.roles).toEqual([])
  })

  it('негодное правило роли пропускается по одному, остальные и их порядок целы', () => {
    write({
      roles: [
        { match: 'a-*', role: 'planner' },
        { match: 'b-*', role: 'unknown' },
        { match: '', role: 'executor' },
        { match: 'c-*', role: 'wizard' },
        'строка',
        null,
        { match: 'd-*', role: 'explore', extra: 1 },
      ],
    })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.roles).toEqual([
      { match: 'a-*', role: 'planner' },
      { match: 'd-*', role: 'explore' },
    ])
    expect(problems.map((p) => p.split(':')[0])).toEqual([
      'workflow.roles[1]',
      'workflow.roles[2]',
      'workflow.roles[3]',
      'workflow.roles[4]',
      'workflow.roles[5]',
    ])
  })

  it('роли не списком — дефолт и замечание', () => {
    write({ roles: { match: 'x', role: 'executor' } })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.roles).toEqual(DEFAULT_CONFIG.workflow.roles)
    expect(problems).toEqual(['workflow.roles: ожидалось список, пришло объект — взят дефолт'])
  })

  it('окно: целые в диапазоне, дробные и нули отклоняются', () => {
    write({ window: { cycles: 0, sessions: 2.5 } })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.window).toEqual(DEFAULT_CONFIG.workflow.window)
    expect(problems).toHaveLength(2)
    write({ window: { cycles: 1, sessions: 50 } })
    expect(loadConfig(path()).config.workflow.window).toEqual({ cycles: 1, sessions: 50 })
  })

  it('цель и пороги — доли; null выключает, вне диапазона отклоняется', () => {
    write({ target: { rework: 0.2 }, alerts: { rework: 0.3, errorRate: 20, overhead: 3 } })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.target.rework).toBe(0.2)
    expect(config.workflow.alerts).toEqual({ rework: 0.3, errorRate: null, overhead: 3 })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('workflow.alerts.errorRate')
    write({ target: { rework: null } })
    expect(loadConfig(path()).config.workflow.target.rework).toBeNull()
  })

  // Проценты вместо долей — самая вероятная ошибка человека: «20» вместо 0.2.
  // Принять её значило бы цель в 2000%, то есть цель, которой никогда не достичь
  // и не нарушить.
  it('цель переделки 20 (проценты вместо доли) отклоняется, а не принимается молча', () => {
    write({ target: { rework: 20 }, alerts: { rework: 1.5, overhead: 5000 } })
    const { config, problems } = loadConfig(path())
    expect(config.workflow.target.rework).toBeNull()
    expect(config.workflow.alerts.rework).toBeNull()
    expect(config.workflow.alerts.overhead).toBeNull()
    expect(problems).toHaveLength(3)
  })

  it('applyPatch: битая регулярка откатывается к текущей, а не к заводской', () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.workflow.verdicts.accepted = 'ОК'
    const { config, problems } = applyPatch(current, { workflow: { verdicts: { accepted: '(' } } })
    expect(config.workflow.verdicts.accepted).toBe('ОК')
    expect(problems.join('\n')).toContain('workflow.verdicts.accepted')
  })

  it('applyPatch: правка ролей заменяет список, соседние настройки целы', () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.workflow.window.cycles = 7
    const { config, problems } = applyPatch(current, {
      workflow: { roles: [{ match: 'x', role: 'executor' }] },
    })
    expect(problems).toEqual([])
    expect(config.workflow.roles).toEqual([{ match: 'x', role: 'executor' }])
    expect(config.workflow.window.cycles).toBe(7)
  })

  it('сохранённый раздел читается обратно без изменений', () => {
    const cfg = structuredClone(DEFAULT_CONFIG)
    cfg.workflow.enabled = true
    cfg.workflow.roles = [{ match: 'x-*', role: 'reviewer' }]
    cfg.workflow.target.rework = 0.25
    cfg.workflow.alerts.overhead = 2.5
    saveConfig(cfg, path())
    const { config, problems } = loadConfig(path())
    expect(problems).toEqual([])
    expect(config).toEqual(cfg)
  })

  it('замечания переведены на английский', () => {
    setLocale('en')
    // Окно и пороги — тоже: «целое 1..1000» было литералом и уезжало кириллицей.
    write({ verdicts: { rejected: '(' }, roles: [1], window: { cycles: 0 }, alerts: { rework: 20 } })
    const { problems } = loadConfig(path())
    expect(problems).toHaveLength(4)
    expect(problems.join('\n')).toContain('an integer 1..1000')
    expect(problems.join('\n')).toContain('a number 0..1 or null')
    expect(problems.join('\n')).toContain('regular expression')
    expect(problems.join('\n')).toContain('rule skipped')
    expect(problems.join('\n')).not.toMatch(/[а-яё]/i)
  })
})
