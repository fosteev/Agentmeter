/**
 * Показатели Workflow под уведомление «пора в /retro» (9.6).
 *
 * Решение «уведомлять ли» — в [`notify.ts`](notify.ts), здесь только то, что ему
 * подаётся: последнее окно трёх показателей и когда его пересчитывать.
 *
 * **Звать `workflowReport` на каждый опрос трея нельзя.** Агрегат стоит ~30 мс
 * на индексе в 1 735 сессий, а трей опрашивается раз в секунду и пока человек
 * работает, вотчер дописывает индекс почти каждую секунду. Поэтому показатели
 * кэшируются, а пересчёт ограничен тремя вещами: индекс изменился (`markStale`),
 * с прошлого пересчёта прошло `MIN_RECOMPUTE_MS`, либо поменялся сам раздел
 * `workflow` конфига — тогда сразу, потому что окно или правила ролей другие, и
 * ждать полминуты со старыми числами значило бы показывать их под новой
 * настройкой.
 *
 * **Единицы — ядра, без пересчёта.** Доли у `rework` и `errorRate`, кратность у
 * `overhead`: порог из конфига стоит в тех же и сравнивается напрямую (9.2).
 *
 * **`latest = null` — показателя нет.** Окно не набралось, знаменатель нулевой
 * или все циклы окна с невидимым исполнителем: «выше порога» из этого не
 * выводится, и в сигналах такого показателя просто нет.
 *
 * **Ключ повода — цикл, а не сессия.** У `rework` и `overhead` `latest.sessionId`
 * — корень последнего цикла окна. У `errorRate` окно в сессиях, и его
 * `latest.sessionId` — последняя сессия: сабагенты рождаются каждые минуты, и
 * ключ менялся бы с каждой, пока доля выше порога. Берётся корень последнего
 * **цикла** отчёта, и повод по ошибкам приходит раз на цикл. Циклов нет — ключа
 * нет, и показатель молчит.
 */
import { workflowReport, type Db, type WorkflowConfig, type WorkflowReport } from '@agentmeter/core'

export type WorkflowMetric = 'rework' | 'errorRate' | 'overhead'

export interface WorkflowSignal {
  /** Доля (`rework`, `errorRate`) или кратность (`overhead`) — как в конфиге. */
  value: number
  /** `≈` в окне накладных: есть восстановленные запросы (1.3). */
  approximate: boolean
  /** Последний цикл окна: часть ключа повода. */
  cycleId: string
}

/** Только определённые показатели: ключа нет — значит «не определён». */
export type WorkflowSignals = Partial<Record<WorkflowMetric, WorkflowSignal>>

/** Не чаще раза в полминуты, пока индекс дописывается: ~30 мс — это 0.1% времени. */
export const MIN_RECOMPUTE_MS = 30_000

export function signalsFromReport(report: WorkflowReport): WorkflowSignals {
  const lastCycle = report.cycles.at(-1)?.sessionId
  const signals: WorkflowSignals = {}
  const rework = report.rework.latest
  if (rework !== null) {
    signals.rework = { value: rework.value, approximate: false, cycleId: rework.sessionId }
  }
  const overhead = report.overhead.latest
  if (overhead !== null) {
    signals.overhead = {
      value: overhead.value,
      approximate: overhead.approximate,
      cycleId: overhead.sessionId,
    }
  }
  const errors = report.errorRate.latest
  if (errors !== null && lastCycle !== undefined) {
    signals.errorRate = { value: errors.value, approximate: false, cycleId: lastCycle }
  }
  return signals
}

/** Пороги разом выключены: считать нечего, агрегат не зовётся. */
function noThresholds(config: WorkflowConfig): boolean {
  const { rework, errorRate, overhead } = config.alerts
  return rework === null && errorRate === null && overhead === null
}

export interface WorkflowSignalsCache {
  /** Индекс дописали: показатели устарели. Пересчёт — при ближайшем `get`, но не чаще `MIN_RECOMPUTE_MS`. */
  markStale(): void
  /**
   * Показатели на сейчас. `undefined` — функция выключена (`enabled === false`):
   * агрегат при этом не зовётся вовсе, он сам `enabled` не читает.
   */
  get(db: Db, config: WorkflowConfig, now?: number): WorkflowSignals | undefined
}

export function createWorkflowSignals(
  compute: (db: Db, config: WorkflowConfig) => WorkflowReport = (db, config) =>
    workflowReport(db, { config }),
): WorkflowSignalsCache {
  let cached: WorkflowSignals | undefined
  let computedAt = 0
  let configKey = ''
  let stale = false

  return {
    markStale() {
      stale = true
    },
    get(db, config, now = Date.now()) {
      if (!config.enabled) {
        // Выключили — забываем: включение заново должно считаться свежим
        // первым снимком, а не доживать на цифрах двухдневной давности.
        cached = undefined
        stale = false
        configKey = ''
        return undefined
      }
      const key = JSON.stringify(config)
      const changed = key !== configKey
      const recent = now - computedAt < MIN_RECOMPUTE_MS
      // Без прежних чисел (первая попытка упала) ждём так же, как с ними: иначе
      // сломанный агрегат звался бы на каждый опрос.
      if (!changed && (cached === undefined ? recent : !stale || recent)) return cached
      configKey = key
      computedAt = now
      stale = false
      if (noThresholds(config)) {
        cached = {}
        return cached
      }
      try {
        cached = signalsFromReport(compute(db, config))
      } catch (error) {
        // Агрегат не должен валить опрос трея. Прежние числа остаются (а если
        // их не было — `undefined`, и уведомления «запомнили» бы не из чего),
        // следующая попытка — не чаще раза в полминуты.
        console.warn(`workflow signals failed: ${String(error)}`)
        // Числа прежних настроек под новыми не годятся.
        if (changed) cached = undefined
      }
      return cached
    },
  }
}
