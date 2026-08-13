/**
 * Уведомления (4.7) — раздел 9 макета, строки 1600–1699.
 *
 * Здесь только **решение**, показывать ли уведомление и что в нём написать.
 * Показ — три строки в `index.ts`: рамку, звук и место на экране рисует ОС.
 * Разделено не ради красоты, а ради проверяемости: планировщик — чистая
 * функция от (что было, что стало, настройки), и мутации по нему гоняются без
 * Electron, которого в тестах нет.
 *
 * ## Четыре правила, на которых всё держится
 *
 * **Первое: уведомление — это сообщение об изменении, а не о состоянии.**
 * Первый снимок после запуска только запоминает, как есть, и не показывает
 * ничего. Иначе каждый запуск приложения объявлял бы вчерашние новости:
 * «Codex закончил» про сессию, которая кончилась ночью, и «92% недельного
 * лимита» про окно, о котором человек уже знает.
 *
 * **Второе: у каждого повода своя личность, и по ней он показывается один
 * раз.** У лимита это окно плюс порог (`provider:минуты:якорь:уровень`), у
 * дорогой сессии — её идентификатор плюс сам порог, у агента — сессия плюс
 * состояние. Опрос идёт раз в секунду, и «показать, пока условие верно»
 * означало бы триста уведомлений за пять минут.
 *
 * **Третье: порог считается пересечённым, а не превышенным.** Окно, в котором
 * мы впервые увидели 94%, — это одно уведомление тревоги, а не тревога плюс
 * предупреждение задним числом: 75% оно тоже превышает, но сказать про них
 * человеку нечего.
 *
 * **Четвёртое: кнопок в уведомлении нет, хотя в макете их две.**
 * `Notification.actions` работает только на macOS и только в подписанном
 * приложении; кнопка, появляющаяся на одной ОС из трёх, хуже её отсутствия —
 * то же правило, что у тумблера автозапуска в 3.6. Обе нарисованные кнопки при
 * этом не потеряны: «Открыть окно» — это клик по самому уведомлению, а «Не
 * напоминать до сброса» и есть второе правило, только всегда включённое.
 *
 * Маршрута «открыть эту задачу» у окна по-прежнему нет, и поля под него тоже.
 * А вот `sessionId` у повода появился в 7.6, и читает его не окно, а
 * [`owner.ts`](owner.ts): клик по уведомлению об агенте поднимает программу,
 * в которой этот агент работает. У поводов про лимит поля нет — лимит
 * принадлежит аккаунту, а не сессии, и открывать по нему чужой редактор не за
 * что.
 */
import { formatTokens, t, type Config } from '@agentmeter/core'
import { locale } from '@agentmeter/core/i18n'
import { isWorking, type TraySnapshot } from '@agentmeter/ipc'

export type NoticeKind = 'warn' | 'danger' | 'session' | 'agent'

export interface Notice {
  /** Личность повода. По ней он показывается один раз. */
  key: string
  kind: NoticeKind
  title: string
  body: string
  /** Чья это сессия. По ней клик поднимает программу агента (7.6). */
  sessionId?: string
}

/**
 * Что мы уже показывали. Живёт в памяти процесса и умирает вместе с ним: после
 * перезапуска первый снимок всё равно ничего не показывает (правило первое), и
 * хранить это на диске значило бы пережить своей полезности.
 */
export interface NotifyState {
  /** Был ли уже снимок. Пока нет — сравнивать не с чем. */
  seeded: boolean
  shown: Set<string>
}

export function emptyNotifyState(): NotifyState {
  return { seeded: false, shown: new Set() }
}

export function planNotifications(
  state: NotifyState,
  snapshot: TraySnapshot,
  config: Config,
): Notice[] {
  const notices = [...limitNotices(snapshot, config), ...sessionNotices(snapshot, config), ...agentNotices(snapshot, config)]
  if (!state.seeded) {
    // Первый снимок только запоминает: всё, что видно сейчас, случилось до
    // запуска, и сообщать об этом как о новости — врать про время.
    state.seeded = true
    for (const notice of notices) state.shown.add(notice.key)
    return []
  }
  const fresh = notices.filter((notice) => !state.shown.has(notice.key))
  for (const notice of fresh) state.shown.add(notice.key)
  // Забываем поводы, которых больше нет: окно сменилось, агент исчез из снимка.
  // Иначе множество растёт весь сеанс, а вернувшийся повод (тот же агент снова
  // ждёт ответа через час) остался бы неназванным.
  const alive = new Set(notices.map((notice) => notice.key))
  for (const key of state.shown) {
    if (!alive.has(key)) state.shown.delete(key)
  }
  return fresh
}

/**
 * Пороги лимита.
 *
 * Процент берётся у окна как есть, вместе с признаком точности: у Claude он
 * оценка до калибровки 1.9, и знак `≈` в заголовке — не украшение, а
 * единственное, чем уведомление отличает измеренное от выведенного.
 */
function limitNotices(snapshot: TraySnapshot, config: Config): Notice[] {
  const notices: Notice[] = []
  for (const row of snapshot.limits) {
    const percent = row.usedPercent
    if (percent == null) continue
    const level =
      percent >= config.alerts.dangerAtPercent
        ? 'danger'
        : percent >= config.alerts.warnAtPercent
          ? 'warn'
          : null
    if (level === null) continue
    const sign = row.exact ? '' : '≈'
    const shown = `${sign}${Math.round(percent)}%`
    notices.push({
      key: `limit:${row.provider}:${row.windowMinutes}:${row.startsAt}:${level}`,
      kind: level,
      title: t('notify.limitTitle', {
        provider: PROVIDER[row.provider],
        percent: shown,
        window: t(WINDOW_KEY[row.kind] ?? 'limit.other'),
      }),
      body: t('notify.limitBody', {
        reset: new Date(row.resetsAt).toLocaleString(locale(), {
          hour: '2-digit',
          minute: '2-digit',
        }),
        agents: t('popup.agents', { count: snapshot.agents.filter(isWorking).length }),
      }),
    })
  }
  return notices
}

/** Сессия дороже заданного числа токенов. Ноль в настройке — не уведомлять. */
function sessionNotices(snapshot: TraySnapshot, config: Config): Notice[] {
  const limit = config.alerts.sessionTokenAlert
  if (limit <= 0) return []
  return snapshot.agents
    .filter((agent) => agent.tokens >= limit)
    .map((agent) => ({
      // Порог в ключе: подними его человек с 50M до 100M, и уведомление про ту
      // же сессию обязано прийти заново — это уже другой повод.
      key: `session:${agent.sessionId}:${limit}`,
      kind: 'session' as const,
      sessionId: agent.sessionId,
      title: t('notify.sessionTitle', { limit: formatTokens(limit, locale()) }),
      body: t('notify.sessionBody', {
        project: agent.project,
        tokens: `${agent.approximate ? '≈' : ''}${formatTokens(agent.tokens, locale())}`,
      }),
    }))
}

/** Агент закончил работу или ждёт ответа. */
function agentNotices(snapshot: TraySnapshot, config: Config): Notice[] {
  if (!config.alerts.notifyOnIdle) return []
  return snapshot.agents
    .filter((agent) => agent.state === 'done' || agent.state === 'waiting')
    .map((agent) => ({
      key: `agent:${agent.sessionId}:${agent.state}`,
      kind: 'agent' as const,
      sessionId: agent.sessionId,
      title: t(agent.state === 'done' ? 'notify.doneTitle' : 'notify.waitingTitle', {
        provider: PROVIDER[agent.provider],
        project: agent.project,
      }),
      body: t('notify.agentBody', {
        tokens: `${agent.approximate ? '≈' : ''}${formatTokens(agent.tokens, locale())}`,
        branch: agent.branch ?? t('notify.noBranch'),
      }),
    }))
}

const PROVIDER = { claude: 'Claude Code', codex: 'Codex' } as const

const WINDOW_KEY: Record<string, 'limit.fiveHour' | 'limit.weekly' | 'limit.monthly' | 'limit.other'> = {
  fiveHour: 'limit.fiveHour',
  weekly: 'limit.weekly',
  monthly: 'limit.monthly',
  other: 'limit.other',
}
