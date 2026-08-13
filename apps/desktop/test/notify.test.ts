import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, setLocale, type Config } from '@agentmeter/core'
import type { LiveAgent, LimitReportRow, TraySnapshot } from '@agentmeter/ipc'
import { emptyNotifyState, planNotifications, type NotifyState } from '../src/main/notify.ts'

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

  /** Ловит уведомление о простое при выключенной настройке. */
  it('выключенный тумблер молчит про агентов, но не про лимиты', () => {
    const quiet = { ...config, alerts: { ...config.alerts, notifyOnIdle: false } }
    planNotifications(state, snap({}), quiet)
    const notices = planNotifications(
      state,
      snap({ limits: [limit(94)], agents: [agent({ state: 'done' })] }),
      quiet,
    )

    expect(notices.map((notice) => notice.kind)).toEqual(['danger'])
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
