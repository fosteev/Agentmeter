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
 * Пятый повод — «пора в /retro» (9.6): показатель Workflow выше порога
 * пользователя. Личность — показатель плюс последний цикл окна, а запоминает
 * его первым снимком **свой** флаг (`workflowSeeded`): показателей может не быть
 * на первом снимке трея, и вчерашнее окно не должно стать новостью оттого, что
 * индекс дочитался позже. Сами показатели считает
 * [`workflow-alerts.ts`](workflow-alerts.ts), не снимок.
 *
 * Маршрута «открыть эту задачу» у окна по-прежнему нет, и поля под него тоже.
 * А вот `sessionId` у повода появился в 7.6, и читает его не окно, а
 * [`owner.ts`](owner.ts): клик по уведомлению об агенте поднимает программу,
 * в которой этот агент работает. У поводов про лимит поля нет — лимит
 * принадлежит аккаунту, а не сессии, и открывать по нему чужой редактор не за
 * что.
 */
import { formatTokens, t, windowTitle, type Config } from '@agentmeter/core'
import { formatPercent } from '@agentmeter/core/format'
import { locale } from '@agentmeter/core/i18n'
import { isWorking, type TraySnapshot } from '@agentmeter/ipc'
import type { WorkflowMetric, WorkflowSignals } from './workflow-alerts.ts'

export type NoticeKind = 'warn' | 'danger' | 'session' | 'agent' | 'workflow'

export interface Notice {
  /** Личность повода. По ней он показывается один раз. */
  key: string
  kind: NoticeKind
  title: string
  body: string
  /** Чья это сессия. По ней клик поднимает программу агента (7.6). */
  sessionId?: string
  /** Какую вкладку окна открыть по клику, если программы агента нет. Нет поля — «Сегодня». */
  tab?: 'workflow'
}

/**
 * Что мы уже показывали. Живёт в памяти процесса и умирает вместе с ним: после
 * перезапуска первый снимок всё равно ничего не показывает (правило первое), и
 * хранить это на диске значило бы пережить своей полезности.
 */
export interface NotifyState {
  /** Был ли уже снимок. Пока нет — сравнивать не с чем. */
  seeded: boolean
  /**
   * То же для показателей Workflow (9.6), отдельно: их может не быть на первом
   * снимке — индекс ещё собирается, функция выключена, — и тогда «первыми» они
   * станут позже. Объявлять новостью вчерашнее окно из-за того, что индекс
   * дочитался на минуту позже трея, нельзя.
   */
  workflowSeeded: boolean
  shown: Set<string>
}

export function emptyNotifyState(): NotifyState {
  return { seeded: false, workflowSeeded: false, shown: new Set() }
}

export function planNotifications(
  state: NotifyState,
  snapshot: TraySnapshot,
  config: Config,
  /** `undefined` — Workflow выключен или показатели ещё не посчитаны: повода нет и запоминать нечего. */
  workflow?: WorkflowSignals,
): Notice[] {
  const base = [
    ...limitNotices(snapshot, config),
    ...sessionNotices(snapshot, config),
    ...agentNotices(snapshot, config),
  ]
  const flow = workflowNotices(workflow, config)
  const notices = [...base, ...flow]
  // Первый снимок только запоминает: всё, что видно сейчас, случилось до
  // запуска, и сообщать об этом как о новости — врать про время.
  const quiet = new Set<string>()
  if (!state.seeded) for (const notice of base) quiet.add(notice.key)
  if (!state.workflowSeeded) for (const notice of flow) quiet.add(notice.key)
  state.seeded = true
  // Пропали показатели (выключили Workflow) — следующий раз снова «первый».
  state.workflowSeeded = workflow !== undefined

  const fresh: Notice[] = []
  for (const notice of notices) {
    if (state.shown.has(notice.key)) continue
    state.shown.add(notice.key)
    if (!quiet.has(notice.key)) fresh.push(notice)
  }
  // Забываем поводы, которых больше нет: окно сменилось, агент исчез из снимка.
  // Иначе множество растёт весь сеанс, а вернувшийся повод (тот же агент снова
  // ждёт ответа через час) остался бы неназванным.
  //
  // У Workflow «повода больше нет» — это новый цикл, а не значение под порогом:
  // показатель не монотонен (доля ошибок сдвигается с каждой сессией, переделка —
  // пока цикл дописывается), и забывай ключ по «стало ниже» — значение, гуляющее
  // у порога, будило бы человека по нескольку раз за одно окно. Ключ живёт, пока
  // цикл показателя тот же.
  const alive = new Set(notices.map((notice) => notice.key))
  for (const key of workflowIdentities(workflow)) alive.add(key)
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
        window: windowTitle(row),
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

/**
 * Агент ждёт ответа или сессия завершилась — два повода, два тумблера (7.8).
 *
 * Разные не по громкости, а по адресату. «Ждёт ответа» — новость: ход перешёл
 * к человеку, пока он смотрел в другое окно. «Завершился» — почти всегда
 * следствие его же действия: он закрыл чат, и через секунду ему сообщают об
 * этом. Один тумблер на оба означал, что за нужное платят ненужным, и
 * выключали обычно оба.
 */
function agentNotices(snapshot: TraySnapshot, config: Config): Notice[] {
  const { notifyOnWaiting, notifyOnDone } = config.alerts
  if (!notifyOnWaiting && !notifyOnDone) return []
  return snapshot.agents
    .filter((agent) =>
      agent.state === 'waiting' ? notifyOnWaiting : agent.state === 'done' && notifyOnDone,
    )
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

/**
 * «Пора в /retro» (9.6): показатель Workflow выше порога пользователя.
 *
 * Порог — настройка, а не вывод продукта, поэтому текст называет факт и порог и
 * не оценивает: «выше вашего порога», а не «плохо». Сравнение прямое и строгое
 * («выше»), в единицах ядра — доля с долей, кратность с кратностью, без ×100 и
 * округления, которое сдвинуло бы срабатывание на границе. Личность повода —
 * показатель и последний цикл окна: новое окно — новый повод, то же окно —
 * тишина, даже если значение успело уйти под порог и вернуться. Порога в ключе
 * нет: опусти его человек ниже текущего значения, повод появится сам — пока
 * условие было ложным, ключ в показанные не попадал.
 *
 * Клик ведёт на вкладку Workflow: повод про неё, а не про чужую сессию.
 */
function workflowNotices(signals: WorkflowSignals | undefined, config: Config): Notice[] {
  if (signals === undefined || !config.workflow.enabled) return []
  const notices: Notice[] = []
  for (const metric of WORKFLOW_METRICS) {
    const threshold = config.workflow.alerts[metric]
    const signal = signals[metric]
    if (threshold === null || signal === undefined) continue
    if (!Number.isFinite(signal.value) || !(signal.value > threshold)) continue
    const shown = formatMetric(metric, signal.value, threshold)
    notices.push({
      key: workflowKey(metric, signal.cycleId),
      kind: 'workflow',
      tab: 'workflow',
      title: t(WORKFLOW_TITLE[metric], {
        value: `${signal.approximate ? '≈' : ''}${shown.value}`,
      }),
      body: t('notify.workflowBody', { threshold: shown.threshold }),
    })
  }
  return notices
}

const WORKFLOW_METRICS: readonly WorkflowMetric[] = ['rework', 'errorRate', 'overhead']

/** Ключи текущих окон всех показателей — выше порога они или нет. */
function workflowIdentities(signals: WorkflowSignals | undefined): string[] {
  if (signals === undefined) return []
  return WORKFLOW_METRICS.flatMap((metric) => {
    const signal = signals[metric]
    return signal === undefined ? [] : [workflowKey(metric, signal.cycleId)]
  })
}

function workflowKey(metric: WorkflowMetric, cycleId: string): string {
  return `workflow:${metric}:${cycleId}`
}

const WORKFLOW_TITLE = {
  rework: 'notify.workflowRework',
  errorRate: 'notify.workflowErrors',
  overhead: 'notify.workflowOverhead',
} as const

/**
 * Значение и порог строкой: доли — процентом, накладные — «×3.2». Если после
 * округления они совпали, добавляется знак: «30% — выше порога 30%» читается как
 * поломка, хотя 30.4 действительно больше 30.
 */
function formatMetric(
  metric: WorkflowMetric,
  value: number,
  threshold: number,
): { value: string; threshold: string } {
  const at = (digits: number): { value: string; threshold: string } =>
    metric === 'overhead'
      ? { value: multiple(value, digits), threshold: multiple(threshold, digits) }
      : {
          value: formatPercent(value, locale(), digits),
          threshold: formatPercent(threshold, locale(), digits),
        }
  const coarse = at(metric === 'overhead' ? 1 : 0)
  if (coarse.value !== coarse.threshold) return coarse
  return at(metric === 'overhead' ? 2 : 1)
}

function multiple(value: number, digits: number): string {
  return `×${new Intl.NumberFormat(locale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)}`
}

const PROVIDER = { claude: 'Claude Code', codex: 'Codex' } as const


