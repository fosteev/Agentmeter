import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, setLocale, type Config, type Db, type WorkflowReport } from '@agentmeter/core'
import type { LiveAgent, LimitReportRow, TraySnapshot } from '@agentmeter/ipc'
import { emptyNotifyState, planNotifications, type NotifyState } from '../src/main/notify.ts'
import {
  MIN_RECOMPUTE_MS,
  createWorkflowSignals,
  signalsFromReport,
  type WorkflowMetric,
  type WorkflowSignals,
} from '../src/main/workflow-alerts.ts'

/**
 * Уведомления (4.7).
 *
 * Проверки названы по поломке, которую ловят, и все они про одно: уведомление
 * — это сообщение об изменении. Опрос идёт раз в секунду, и правило «показать,
 * пока условие верно» дало бы триста уведомлений за пять минут; правило «всё,
 * что видно при запуске» — вчерашние новости при каждом старте.
 */

const config: Config = {
  ...DEFAULT_CONFIG,
  ui: { ...DEFAULT_CONFIG.ui, locale: 'ru' },
  alerts: { ...DEFAULT_CONFIG.alerts, sessionTokenAlert: 50_000_000 },
}

let state: NotifyState

beforeEach(() => {
  setLocale('ru')
  state = emptyNotifyState()
})

describe('planNotifications', () => {
  /**
   * Ловит уведомления при запуске. Всё, что видно на первом снимке, случилось
   * до старта приложения: «Codex закончил» про ночную сессию и «92% лимита» про
   * окно, о котором человек знает, — это не новости, а пересказ.
   */
  it('первый снимок ничего не показывает, а только запоминает', () => {
    const snapshot = snap({ limits: [limit(94)], agents: [agent({ state: 'done' })] })

    expect(planNotifications(state, snapshot, config)).toEqual([])
    // И повторно не показывает: повод тот же самый.
    expect(planNotifications(state, snapshot, config)).toEqual([])
  })

  /**
   * Ловит уведомление на каждый опрос. Порог пересекается один раз, а верным
   * остаётся часами; показывать его тысячу раз значит сделать уведомления тем,
   * что выключают.
   */
  it('один повод — одно уведомление, сколько бы снимков ни пришло', () => {
    planNotifications(state, snap({}), config)
    const first = planNotifications(state, snap({ limits: [limit(94)] }), config)
    const again = planNotifications(state, snap({ limits: [limit(95)] }), config)

    expect(first).toHaveLength(1)
    expect(first[0]!.kind).toBe('danger')
    expect(again).toEqual([])
  })

  /**
   * Ловит два уведомления на одно окно. 94% превышает и порог тревоги, и порог
   * предупреждения, но сказать человеку про 75% уже нечего.
   */
  it('пересечённым считается один порог, самый высокий', () => {
    planNotifications(state, snap({}), config)
    const notices = planNotifications(state, snap({ limits: [limit(94)] }), config)

    expect(notices.map((notice) => notice.kind)).toEqual(['danger'])
  })

  /**
   * Ловит окно, узнанное по провайдеру: лимит сбрасывается, начинается новое
   * окно с тем же именем — и про него надо сказать заново. Личность окна это
   * его якорь (1.8), а не слот.
   */
  it('новое окно того же провайдера — новый повод', () => {
    planNotifications(state, snap({}), config)
    planNotifications(state, snap({ limits: [limit(94, 1000)] }), config)
    const next = planNotifications(state, snap({ limits: [limit(94, 2000)] }), config)

    expect(next).toHaveLength(1)
  })

  /**
   * Ловит процент, показанный без знака оценки. У Claude до калибровки 1.9 он
   * выведен, а не измерен, и уведомление — самое заметное место, где эту
   * разницу можно потерять.
   */
  it('оценка помечена знаком, точное измерение — нет', () => {
    planNotifications(state, snap({}), config)
    const estimate = planNotifications(state, snap({ limits: [limit(94, 1000, false)] }), config)
    state = emptyNotifyState()
    planNotifications(state, snap({}), config)
    const exact = planNotifications(state, snap({ limits: [limit(94, 1000, true)] }), config)

    expect(estimate[0]!.title).toContain('≈94%')
    expect(exact[0]!.title).toContain('94%')
    expect(exact[0]!.title).not.toContain('≈')
  })

  /**
   * Ловит порог сессии, зашитый в код, и порог, изменённый без последствий:
   * подними человек его вдвое — и про ту же сессию надо сказать заново, это
   * уже другой повод.
   */
  it('порог дорогой сессии берётся из настроек и входит в личность повода', () => {
    const rich = snap({ agents: [agent({ tokens: 62_000_000 })] })
    planNotifications(state, snap({}), config)

    expect(planNotifications(state, rich, config)).toHaveLength(1)
    expect(planNotifications(state, rich, config)).toEqual([])
    expect(
      planNotifications(state, rich, {
        ...config,
        alerts: { ...config.alerts, sessionTokenAlert: 60_000_000 },
      }),
    ).toHaveLength(1)
  })

  /** Ловит уведомление про сессию при выключенном пороге: ноль значит «не надо». */
  it('нулевой порог сессии выключает уведомление совсем', () => {
    const off = { ...config, alerts: { ...config.alerts, sessionTokenAlert: 0 } }
    planNotifications(state, snap({}), off)

    expect(planNotifications(state, snap({ agents: [agent({ tokens: 9e9 })] }), off)).toEqual([])
  })

  /**
   * Ловит агента, о котором сказали один раз за всё время. Тот же агент,
   * закончивший ход и снова ждущий ответа через час, — это два разных повода, и
   * второй обязан прозвучать.
   */
  it('смена состояния агента — новый повод, возвращение прежнего — тоже', () => {
    planNotifications(state, snap({}), config)
    const waiting = planNotifications(state, snap({ agents: [agent({ state: 'waiting' })] }), config)
    const working = planNotifications(state, snap({ agents: [agent({ state: 'working' })] }), config)
    const again = planNotifications(state, snap({ agents: [agent({ state: 'waiting' })] }), config)

    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.title).toContain('ждёт ответа')
    expect(working).toEqual([])
    expect(again).toHaveLength(1)
  })

  /**
   * Ловит повод, по которому нечего открыть. Клик по уведомлению об агенте
   * поднимает программу, в которой он работает (7.6), и найти её можно только
   * по сессии. У лимита сессии нет и быть не может: процент считается по
   * аккаунту, а не по чату, и открывать по нему чей-то редактор не за что.
   */
  it('повод об агенте несёт сессию, повод о лимите — нет', () => {
    planNotifications(state, snap({}), config)
    const notices = planNotifications(
      state,
      snap({ limits: [limit(94)], agents: [agent({ state: 'waiting', tokens: 9e9 })] }),
      config,
    )

    expect(notices.map((notice) => [notice.kind, notice.sessionId])).toEqual([
      ['danger', undefined],
      ['session', 'seed'],
      ['agent', 'seed'],
    ])
  })

  /** Ловит уведомление о простое при выключенных настройках. */
  it('выключенные тумблеры молчат про агентов, но не про лимиты', () => {
    const quiet = {
      ...config,
      alerts: { ...config.alerts, notifyOnWaiting: false, notifyOnDone: false },
    }
    planNotifications(state, snap({}), quiet)
    const notices = planNotifications(
      state,
      snap({ limits: [limit(94)], agents: [agent({ state: 'done' })] }),
      quiet,
    )

    expect(notices.map((notice) => notice.kind)).toEqual(['danger'])
  })

  /**
   * Ловит уведомление на закрытие чата при заводских настройках (7.8).
   *
   * `done` — это исчезнувший процесс, то есть чаще всего человек сам закрыл
   * чат: уведомление приходило на его же действие через секунду после него.
   * «Ждёт ответа» при этом обязано остаться — ради него всё и включено.
   */
  it('по умолчанию сообщает про ждущего и молчит про завершившегося', () => {
    planNotifications(state, snap({}), config)
    const notices = planNotifications(
      state,
      snap({
        agents: [
          agent({ sessionId: 'a', state: 'waiting' }),
          agent({ sessionId: 'b', state: 'done' }),
        ],
      }),
      config,
    )

    expect(notices.map((notice) => notice.sessionId)).toEqual(['a'])
  })

  /** Ловит тумблеры, перепутанные местами: включён «завершился», молчит «ждёт». */
  it('тумблер завершения включается отдельно от тумблера ожидания', () => {
    const ends = {
      ...config,
      alerts: { ...config.alerts, notifyOnWaiting: false, notifyOnDone: true },
    }
    planNotifications(state, snap({}), ends)
    const notices = planNotifications(
      state,
      snap({
        agents: [
          agent({ sessionId: 'a', state: 'waiting' }),
          agent({ sessionId: 'b', state: 'done' }),
        ],
      }),
      ends,
    )

    expect(notices.map((notice) => notice.sessionId)).toEqual(['b'])
  })

  /**
   * Ловит окно без процента, показанное как ноль. У Claude до калибровки 1.9
   * процента нет вовсе, и «0% лимита» — утверждение, которого мы не делали.
   */
  it('окно без процента не повод для уведомления', () => {
    planNotifications(state, snap({}), config)
    const unknown = { ...limit(94), usedPercent: null }

    expect(planNotifications(state, snap({ limits: [unknown] }), config)).toEqual([])
  })
})

/**
 * «Пора в /retro» (9.6). Те же четыре правила, что у остальных поводов, плюс два
 * своих: порог — настройка пользователя, а не вывод продукта (текст не
 * оценивает), и показатель, которого нет (`null`), — не повод.
 */
describe('planNotifications · Workflow', () => {
  const flow: Config = {
    ...config,
    workflow: {
      ...config.workflow,
      enabled: true,
      alerts: { rework: 0.3, errorRate: 0.1, overhead: 3 },
    },
  }
  const quiet = snap({})

  /** Ловит уведомление при запуске: окно выше порога, а приложение только открылось. */
  it('первый снимок только запоминает', () => {
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))).toEqual([])
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))).toEqual([])
  })

  /** Ловит порог, сравниваемый «в другую сторону» или не с тем показателем. */
  it('ниже порога — тишина; пересёк — одно уведомление', () => {
    planNotifications(state, quiet, flow, sig({ rework: [0.1, 'c1'] }))
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.29, 'c1'] }))).toEqual([])

    const crossed = planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))
    expect(crossed).toHaveLength(1)
    expect(crossed[0]!.key).toBe('workflow:rework:c1')
    expect(crossed[0]!.kind).toBe('workflow')
    expect(crossed[0]!.tab).toBe('workflow')
    expect(crossed[0]!.sessionId).toBeUndefined()
  })

  /** Ловит уведомление на каждый опрос: цикл тот же, значение чуть сдвинулось. */
  it('следующий снимок того же окна — тишина', () => {
    planNotifications(state, quiet, flow, sig({ rework: [0.1, 'c1'] }))
    planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))

    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))).toEqual([])
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.51, 'c1'] }))).toEqual([])
  })

  /**
   * Ловит забывание ключа по «стало ниже порога»: показатель не монотонен
   * (доля ошибок сдвигается с каждой сессией при том же последнем цикле), и
   * значение, гуляющее у порога, будило бы человека несколько раз за одно окно.
   */
  it('ушло под порог и вернулось в том же окне — тишина', () => {
    planNotifications(state, quiet, flow, sig({ errorRate: [0.05, 'c1'] }))
    expect(planNotifications(state, quiet, flow, sig({ errorRate: [0.12, 'c1'] }))).toHaveLength(1)
    expect(planNotifications(state, quiet, flow, sig({ errorRate: [0.09, 'c1'] }))).toEqual([])
    expect(planNotifications(state, quiet, flow, sig({ errorRate: [0.12, 'c1'] }))).toEqual([])
    // Новый цикл — новое окно, и ключ прошлого наконец забыт.
    expect(planNotifications(state, quiet, flow, sig({ errorRate: [0.12, 'c2'] }))).toHaveLength(1)
  })

  /** Ловит порог, вошедший в личность повода: опустили ниже значения — повод сразу. */
  it('порог опустили ниже текущего значения — повод', () => {
    planNotifications(state, quiet, flow, sig({ rework: [0.25, 'c1'] }))
    const lower = { ...flow, workflow: { ...flow.workflow, alerts: { ...flow.workflow.alerts, rework: 0.2 } } }

    expect(planNotifications(state, quiet, lower, sig({ rework: [0.25, 'c1'] }))).toHaveLength(1)
  })

  /** Ловит ключ без цикла: новое окно выше порога — новый повод. */
  it('новое окно выше порога — снова', () => {
    planNotifications(state, quiet, flow, sig({ rework: [0.1, 'c1'] }))
    planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))
    const next = planNotifications(state, quiet, flow, sig({ rework: [0.4, 'c2'] }))

    expect(next.map((notice) => notice.key)).toEqual(['workflow:rework:c2'])
  })

  /** Ловит «не определён» как «выше порога»: окно не набралось, `latest = null`. */
  it('показатель без значения — никогда; порог null — никогда', () => {
    planNotifications(state, quiet, flow, sig({}))
    expect(planNotifications(state, quiet, flow, sig({}))).toEqual([])

    const off = {
      ...flow,
      workflow: { ...flow.workflow, alerts: { rework: null, errorRate: null, overhead: null } },
    }
    const all = sig({ rework: [0.9, 'c1'], errorRate: [0.9, 'c1'], overhead: [30, 'c1'] })
    planNotifications(state, quiet, off, all)
    expect(planNotifications(state, quiet, off, sig({ rework: [0.9, 'c2'] }))).toEqual([])
  })

  /** Ловит порог одного показателя, применённый к другому: у каждого свой. */
  it('у каждого показателя свой порог', () => {
    planNotifications(state, quiet, flow, sig({}))
    const notices = planNotifications(
      state,
      quiet,
      flow,
      sig({ rework: [0.29, 'c1'], errorRate: [0.11, 'c1'], overhead: [2.9, 'c1'] }),
    )

    expect(notices.map((notice) => notice.key)).toEqual(['workflow:errorRate:c1'])
  })

  /** Ловит `>=` вместо `>`: «выше порога» на самом пороге — неправда в тексте. */
  it('значение, равное порогу, — тишина', () => {
    planNotifications(state, quiet, flow, sig({}))
    const notices = planNotifications(
      state,
      quiet,
      flow,
      sig({ rework: [0.3, 'c1'], overhead: [3, 'c1'] }),
    )

    expect(notices).toEqual([])
  })

  /** Ловит уведомления у человека, который функцию не включал: сигналы пришли, `enabled` — нет. */
  it('Workflow выключен — никогда', () => {
    const disabled = { ...flow, workflow: { ...flow.workflow, enabled: false } }
    planNotifications(state, quiet, disabled, sig({ rework: [0.1, 'c1'] }))

    expect(planNotifications(state, quiet, disabled, sig({ rework: [0.9, 'c2'] }))).toEqual([])
  })

  /**
   * Ловит вчерашнее окно, объявленное новостью: индекс дособрался уже после
   * первого снимка трея, и первыми показатели стали на втором.
   */
  it('показатели, появившиеся после первого снимка, тоже сначала запоминаются', () => {
    planNotifications(state, quiet, flow, undefined)
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))).toEqual([])
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))).toEqual([])
    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c2'] }))).toHaveLength(1)
  })

  /** Ловит включение функции поверх старого окна: выключили, включили — это снова «первый снимок». */
  it('выключение и повторное включение запоминают заново', () => {
    planNotifications(state, quiet, flow, sig({ rework: [0.1, 'c1'] }))
    planNotifications(state, quiet, flow, undefined)

    expect(planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))).toEqual([])
  })

  /** Ловит сброс остальных поводов: отдельное запоминание Workflow не должно будить лимиты. */
  it('Workflow не отменяет «первый снимок» остальных поводов', () => {
    const first = planNotifications(
      state,
      snap({ limits: [limit(94)] }),
      flow,
      sig({ rework: [0.46, 'c1'] }),
    )
    expect(first).toEqual([])
    const second = planNotifications(
      state,
      snap({ limits: [limit(94)], agents: [agent({ state: 'waiting' })] }),
      flow,
      sig({ rework: [0.46, 'c1'] }),
    )
    expect(second.map((notice) => notice.kind)).toEqual(['agent'])
  })

  /** Ловит слова оценки и потерянные подстановки; проценты — из долей, накладные — кратностью. */
  it('текст: показатель, значение и порог, без оценки', () => {
    planNotifications(state, quiet, flow, sig({}))
    const [rework, errors, overhead] = planNotifications(
      state,
      quiet,
      flow,
      sig({ rework: [0.46, 'c1'], errorRate: [0.125, 'c1'], overhead: [3.24, 'c1', true] }),
    )

    expect(rework!.title).toBe('Доля переделки — 46%')
    expect(rework!.body).toBe('Выше вашего порога 30%. Повод разобрать логи: /retro')
    expect(errors!.title).toBe('Доля ошибок инструментов — 13%')
    expect(overhead!.title).toBe('Накладные цикла — ≈×3,2')
    expect(overhead!.body).toContain('×3.')
    for (const notice of [rework!, errors!, overhead!]) {
      expect(`${notice.title} ${notice.body}`).not.toMatch(/плох|bad|worse|{{/i)
    }
  })

  it('текст на английском', () => {
    setLocale('en')
    planNotifications(state, quiet, flow, sig({}))
    const [notice] = planNotifications(state, quiet, flow, sig({ rework: [0.46, 'c1'] }))

    expect(notice!.title).toBe('Rework share — 46%')
    expect(notice!.body).toBe('Above your threshold of 30%. Time to review the logs: /retro')
  })

  /** Ловит «30% — выше порога 30%»: после округления значение и порог совпали, но 30.4 > 30. */
  it('значение и порог, совпавшие после округления, показываются точнее', () => {
    planNotifications(state, quiet, flow, sig({}))
    const [notice] = planNotifications(state, quiet, flow, sig({ rework: [0.304, 'c1'] }))

    expect(notice!.title).toBe('Доля переделки — 30,4%')
    expect(notice!.body).toContain('30,0%')
  })
})

describe('signalsFromReport', () => {
  /** Ловит ключ ошибок по сессии: она меняется каждые минуты, и повод шёл бы на каждую. */
  it('ключ ошибок — последний цикл, а не последняя сессия окна', () => {
    const report = fakeReport({
      cycles: ['c1', 'c2'],
      errorRate: { value: 0.2, sessionId: 'subagent-9' },
    })

    expect(signalsFromReport(report).errorRate?.cycleId).toBe('c2')
  })

  it('циклов нет — у ошибок нет ключа, показателя нет', () => {
    const report = fakeReport({ cycles: [], errorRate: { value: 0.2, sessionId: 's' } })

    expect(signalsFromReport(report).errorRate).toBeUndefined()
  })

  /** Ловит `latest = null`, превращённый в ноль или в нижнюю границу. */
  it('latest = null — показателя в сигналах нет', () => {
    const report = fakeReport({ cycles: ['c1'] })

    expect(signalsFromReport(report)).toEqual({})
  })

  it('rework и overhead берут корень последнего цикла окна, ≈ — у накладных', () => {
    const report = fakeReport({
      cycles: ['c1', 'c2'],
      rework: { value: 0.5, sessionId: 'c2' },
      overhead: { value: 3.2, sessionId: 'c2', approximate: true },
    })

    expect(signalsFromReport(report)).toEqual({
      rework: { value: 0.5, approximate: false, cycleId: 'c2' },
      overhead: { value: 3.2, approximate: true, cycleId: 'c2' },
    })
  })
})

describe('createWorkflowSignals', () => {
  const db = {} as Db
  const on = {
    ...DEFAULT_CONFIG.workflow,
    enabled: true,
    alerts: { rework: 0.3, errorRate: null, overhead: null },
  }
  const report = (): WorkflowReport =>
    fakeReport({ cycles: ['c1'], rework: { value: 0.5, sessionId: 'c1' } })

  function counting(): { compute: () => WorkflowReport; calls: () => number } {
    let calls = 0
    return {
      compute: () => {
        calls += 1
        return report()
      },
      calls: () => calls,
    }
  }

  /** Ловит расход при выключенной функции: агрегат сам `enabled` не читает. */
  it('выключено — агрегат не зовётся, ответ undefined', () => {
    const { compute, calls } = counting()
    const cache = createWorkflowSignals(compute)

    expect(cache.get(db, { ...on, enabled: false }, 0)).toBeUndefined()
    expect(calls()).toBe(0)
  })

  /** Ловит агрегат на каждый опрос трея: раз в секунду по 30 мс. */
  it('индекс не менялся — второй раз не считает', () => {
    const { compute, calls } = counting()
    const cache = createWorkflowSignals(compute)

    for (let at = 0; at < 100_000; at += 1000) cache.get(db, on, at)

    expect(calls()).toBe(1)
  })

  /** Ловит два перекоса сразу: пересчёт, которого нет после изменения индекса, и пересчёт на каждую секунду. */
  it('индекс дописан — пересчёт, но не чаще раза в MIN_RECOMPUTE_MS', () => {
    const { compute, calls } = counting()
    const cache = createWorkflowSignals(compute)
    cache.get(db, on, 0)

    cache.markStale()
    cache.get(db, on, 1000)
    expect(calls()).toBe(1)

    cache.get(db, on, MIN_RECOMPUTE_MS)
    expect(calls()).toBe(2)
    // И пометка снята: без нового изменения третьего пересчёта нет.
    cache.get(db, on, MIN_RECOMPUTE_MS * 5)
    expect(calls()).toBe(2)
  })

  /** Ловит старые числа под новой настройкой: окно другого размера — другие показатели. */
  it('поменялся раздел workflow — пересчёт сразу', () => {
    const { compute, calls } = counting()
    const cache = createWorkflowSignals(compute)
    cache.get(db, on, 0)

    cache.get(db, { ...on, window: { cycles: 5, sessions: 20 } }, 1000)

    expect(calls()).toBe(2)
  })

  it('все пороги выключены — агрегат не зовётся', () => {
    const { compute, calls } = counting()
    const cache = createWorkflowSignals(compute)
    const nothing = { ...on, alerts: { rework: null, errorRate: null, overhead: null } }

    expect(cache.get(db, nothing, 0)).toEqual({})
    expect(calls()).toBe(0)
  })

  /** Ловит падение агрегата в опросе трея и потерянные старые числа. */
  it('агрегат упал — прежние числа остаются, трей не падает', () => {
    let fail = false
    const cache = createWorkflowSignals(() => {
      if (fail) throw new Error('boom')
      return report()
    })
    const first = cache.get(db, on, 0)
    fail = true
    cache.markStale()

    expect(cache.get(db, on, MIN_RECOMPUTE_MS)).toEqual(first)
  })

  it('первая попытка упала — undefined, а не «пусто»', () => {
    const cache = createWorkflowSignals(() => {
      throw new Error('boom')
    })

    expect(cache.get(db, on, 0)).toBeUndefined()
  })
})

type Point = [value: number, cycleId: string, approximate?: boolean]

function sig(parts: Partial<Record<WorkflowMetric, Point>>): WorkflowSignals {
  const signals: WorkflowSignals = {}
  for (const [metric, point] of Object.entries(parts) as [WorkflowMetric, Point][]) {
    signals[metric] = { value: point[0], cycleId: point[1], approximate: point[2] ?? false }
  }
  return signals
}

function fakeReport(parts: {
  cycles: string[]
  rework?: { value: number; sessionId: string }
  overhead?: { value: number; sessionId: string; approximate?: boolean }
  errorRate?: { value: number; sessionId: string }
}): WorkflowReport {
  const series = (point?: { value: number; sessionId: string; approximate?: boolean }) => ({
    size: 10,
    count: 10,
    points: [],
    latest:
      point === undefined
        ? null
        : { n: 10, startedAt: 0, numerator: 0, denominator: 1, approximate: false, ...point },
    prev: null,
    delta: null,
  })
  return {
    emptyIndex: false,
    emptyScope: false,
    cycles: parts.cycles.map((sessionId) => ({ sessionId })),
    rework: series(parts.rework),
    overhead: series(parts.overhead),
    errorRate: series(parts.errorRate),
    verdicts: series(),
  } as unknown as WorkflowReport
}

function snap(parts: { limits?: LimitReportRow[]; agents?: LiveAgent[] }): TraySnapshot {
  return {
    at: 1_700_000_000_000,
    agents: parts.agents ?? [],
    limits: parts.limits ?? [],
    today: {
      input: exact(0),
      output: exact(0),
      cacheWrite: exact(0),
      cacheRead: exact(0),
      total: exact(0),
      requests: 0,
      sessions: 0,
      projects: 0,
    },
    problems: [],
  }
}

function exact(value: number) {
  return { value, confidence: 'exact' as const }
}

function limit(percent: number, startsAt = 1000, exactPercent = false): LimitReportRow {
  return {
    provider: 'claude',
    kind: 'fiveHour',
    windowMinutes: 300,
    startsAt,
    resetsAt: startsAt + 300 * 60_000,
    usedPercent: percent,
    observedAt: startsAt,
    exact: exactPercent,
    unavailableReason: null,
    forecast: null,
  }
}

function agent(parts: Partial<LiveAgent>): LiveAgent {
  return {
    sessionId: 'seed',
    provider: 'codex',
    project: 'pilot',
    cwd: '/proj/pilot',
    entrypoint: 'cli',
    startedAt: 1_699_999_000_000,
    state: 'working',
    tokens: 1000,
    approximate: false,
    rate: 0,
    ...parts,
  }
}
