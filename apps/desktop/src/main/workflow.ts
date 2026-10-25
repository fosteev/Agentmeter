/**
 * Вкладка «Workflow» (9.5) — раздел 13 макета, украшение `workflowReport`.
 *
 * Тот же довод, что у `matrix.ts`: счёт сделан в ядре (9.3), и второго здесь нет
 * ни в одном месте. Файл переводит готовый ответ в то, что видно числом, — доли
 * ролей из сумм, дельты в п.п., кратность накладных цикла, подрезка ряда ошибок —
 * и больше ничего. Окну остаётся подогнать длины полосок и положение точек
 * (правило 13): окно **не** пересчитывает ни одно окно ряда, `latest` и `prev`
 * рисуются как пришли.
 *
 * Текст головы ответа сабагента сюда не доезжает: ядро отдаёт вердикт, а
 * `last_text_head` остаётся в индексе. Проверка — `workflow.test.tsx`, по ключам
 * всего ответа.
 *
 * Чистая сборка (`toWorkflowScreen`) отделена от вызова ядра (`buildWorkflowScreen`):
 * первую можно проверить на отчёте, собранном руками, не поднимая индекс.
 */
import { workflowReport, type Db } from '@agentmeter/core'
import type {
  RequestScope,
  WorkflowConfig,
  WorkflowCycle,
  WorkflowPoint,
  WorkflowReport,
  WorkflowSeries,
} from '@agentmeter/core'
import type {
  WorkflowControl,
  WorkflowCycleTip,
  WorkflowDelta,
  WorkflowDot,
  WorkflowFilter,
  WorkflowReworkBlock,
  WorkflowRoleKey,
  WorkflowRolesBlock,
  WorkflowScreen,
  WorkflowVerdictsControl,
  WorkflowWindowValue,
} from '@agentmeter/ipc'

/**
 * Сколько последних окон ошибок уходит в окно приложения (9.4: «последние 48
 * окон», в пределах 40–60 брифа). На живом индексе в ряду 1 369 точек по семь
 * полей — слать их целиком незачем, а читается только хвост.
 */
export const ERROR_POINTS = 48

/** Порядок ролей на экране: главная первой, `unknown` последним и всегда. */
const ROLE_ORDER: readonly WorkflowRoleKey[] = [
  'main',
  'executor',
  'reviewer',
  'planner',
  'explore',
  'unknown',
]

/** Роли блока «после исполнителя»: исполнитель сюда не входит по определению. */
const AFTER_ROLES: readonly WorkflowRoleKey[] = ['main', 'reviewer', 'planner', 'explore', 'unknown']
/** Эти две строки показываются всегда — остальные только при ненулевом счёте. */
const AFTER_ALWAYS: readonly WorkflowRoleKey[] = ['main', 'reviewer']

export function buildWorkflowScreen(
  db: Db,
  config: WorkflowConfig,
  filter: WorkflowFilter,
): WorkflowScreen {
  const scope: RequestScope = filter.project === undefined ? {} : { project: filter.project }
  const report = workflowReport(db, { config, scope })
  // Список проектов — по циклам **без** сужения: после выбора проекта сегменты
  // не должны схлопнуться до него одного, иначе назад выбраться нечем. Второй
  // проход нужен только при фильтре; без него список берётся из самого ответа.
  const wide = filter.project === undefined ? report : workflowReport(db, { config })
  return toWorkflowScreen(report, config, {
    ...(filter.project === undefined ? {} : { project: filter.project }),
    projects: projectsOf(wide.cycles),
  })
}

export function projectsOf(
  cycles: readonly Pick<WorkflowCycle, 'project'>[],
): WorkflowScreen['projects'] {
  const counts = new Map<string, number>()
  for (const cycle of cycles) counts.set(cycle.project, (counts.get(cycle.project) ?? 0) + 1)
  // Больше циклов — раньше; при равенстве — по имени: порядок сегментов не должен
  // зависеть от того, какой проект запустили последним.
  return [...counts.entries()]
    .map(([name, cycles]) => ({ name, cycles }))
    .sort((a, b) => b.cycles - a.cycles || a.name.localeCompare(b.name))
}

export function toWorkflowScreen(
  report: WorkflowReport,
  config: WorkflowConfig,
  context: { project?: string; projects: WorkflowScreen['projects'] },
): WorkflowScreen {
  const { cycles } = report
  const size = report.rework.size
  const state: WorkflowScreen['state'] = report.emptyIndex
    ? 'indexing'
    : report.emptyScope
      ? 'scope'
      : cycles.length === 0
        ? 'none'
        : 'ready'

  return {
    state,
    ...(context.project === undefined ? {} : { project: context.project }),
    projects: context.projects,
    period:
      cycles.length === 0
        ? null
        : { from: cycles[0]!.startedAt, to: cycles[cycles.length - 1]!.startedAt },
    window: { cycles: config.window.cycles, sessions: config.window.sessions },
    cycles: cycles.map((cycle, index) => toTip(cycle, index + 1)),
    rework: toRework(report, config.target.rework, size),
    overhead: toControl(report.overhead, 1),
    errors: { ...toControl(report.errorRate, 100), points: dots(report.errorRate).slice(-ERROR_POINTS) },
    verdicts: toVerdicts(report),
    roles: toRoles(report),
  }
}

// ─── главное число ────────────────────────────────────────────────────────────

function toRework(
  report: WorkflowReport,
  target: number | null,
  size: number,
): WorkflowReworkBlock {
  const { rework, cycles } = report
  const { latest, prev } = rework
  const last = cycles.slice(Math.max(0, cycles.length - size))
  const withUnseen = (point: NonNullable<typeof latest>) => ({
    ...windowValue(point),
    unseen: point.unseen,
  })

  const delta =
    rework.delta === null || latest === null || prev === null
      ? null
      : {
          value: rework.delta * 100,
          approximate: latest.approximate || prev.approximate,
          // Цвет — движение к цели, а не оценка (9.4): `--ok` только при заданной
          // цели и сократившемся недоборе до неё. Цель — потолок («≤ 20%»), поэтому
          // недобор — `max(0, value − target)`, а не модуль разности: рост 15% → 18%
          // под целью 20% модуль покрасил бы «к цели», а спуск 22% → 10% — нет.
          // Внутри цели недобор ноль у обоих окон, и дельта нейтральна в обе стороны.
          tone: target !== null && gap(latest.value, target) < gap(prev.value, target)
            ? ('toward' as const)
            : ('neutral' as const),
        }

  return {
    size,
    count: rework.count,
    short: rework.count < size,
    latest: latest === null ? null : withUnseen(latest),
    prev: prev === null ? null : withUnseen(prev),
    unseen: last.filter((cycle) => cycle.executorUnseen).length,
    lastStartedAt: cycles.length === 0 ? null : cycles[cycles.length - 1]!.startedAt,
    delta,
    // Дельты нет при живом числе по одной из двух причин, и слова у них разные.
    noDelta: latest === null || delta !== null ? null : rework.count < 2 * size ? 'short' : 'noPoint',
    need: 2 * size,
    target,
    points: rework.points.map((point) => ({
      n: point.n,
      startedAt: point.startedAt,
      value: point.value,
      numerator: point.numerator,
      denominator: point.denominator,
      approximate: point.approximate,
      unseen: point.unseen,
    })),
  }
}

/** Сколько окну осталось до цели-потолка; ноль — цель достигнута. */
function gap(value: number, target: number): number {
  return Math.max(0, value - target)
}

// ─── подсказка точки ──────────────────────────────────────────────────────────

function toTip(cycle: WorkflowCycle, n: number): WorkflowCycleTip {
  const spent = cycle.spend
  return {
    n,
    startedAt: cycle.startedAt,
    project: cycle.project,
    unseen: cycle.executorUnseen,
    executorWrites: cycle.writes.executor,
    after: AFTER_ROLES.filter((role) => cycle.writesAfter[role] > 0).map((role) => ({
      role,
      count: cycle.writesAfter[role],
    })),
    // Расход исполнителя ноль — «—», а не бесконечность. Накладных цикла в ядре нет
    // (только `spend` по ролям): кратность делится здесь тем же `(main + reviewer) /
    // executor`, которым ядро сводит окно.
    overhead: spent.executor > 0 ? (spent.main + spent.reviewer) / spent.executor : null,
    overheadApproximate: cycle.inherited,
  }
}

// ─── три контрольных ──────────────────────────────────────────────────────────

function windowValue(point: WorkflowPoint): WorkflowWindowValue {
  return {
    value: point.value,
    numerator: point.numerator,
    denominator: point.denominator,
    startedAt: point.startedAt,
    approximate: point.approximate,
  }
}

function dots(series: WorkflowSeries): WorkflowDot[] {
  return series.points.map((point) => ({
    n: point.n,
    startedAt: point.startedAt,
    value: point.value,
    numerator: point.numerator,
    denominator: point.denominator,
    approximate: point.approximate,
  }))
}

/** `scale`: 100 у долей — дельта уходит в п.п.; 1 у кратности. */
function toControl(series: WorkflowSeries, scale: number): WorkflowControl {
  const { latest, prev } = series
  const delta: WorkflowDelta | null =
    series.delta === null || latest === null || prev === null
      ? null
      : { value: series.delta * scale, approximate: latest.approximate || prev.approximate }
  return {
    size: series.size,
    count: series.count,
    latest: latest === null ? null : windowValue(latest),
    prev: prev === null ? null : windowValue(prev),
    delta,
    points: dots(series),
  }
}

function toVerdicts(report: WorkflowReport): WorkflowVerdictsControl {
  const { verdicts } = report
  return {
    ...toControl(verdicts, 100),
    counts: verdicts.latest === null ? null : { ...verdicts.latest.counts },
  }
}

// ─── роли ─────────────────────────────────────────────────────────────────────

function toRoles(report: WorkflowReport): WorkflowRolesBlock {
  const { roles } = report
  const spend = ROLE_ORDER.reduce((sum, role) => sum + roles.spend[role], 0)
  const afterTotal = AFTER_ROLES.reduce((sum, role) => sum + roles.afterByRole[role], 0)
  const part = (count: number, whole: number): number => (whole === 0 ? 0 : count / whole)

  const shown = AFTER_ROLES.filter(
    (role) => AFTER_ALWAYS.includes(role) || roles.afterByRole[role] > 0,
  )
  return {
    cycles: roles.cycles,
    unseen: roles.unseen,
    rows: ROLE_ORDER.map((role) => ({
      role,
      spend: roles.spend[role],
      share: part(roles.spend[role], spend),
      writes: roles.writes[role],
      // После себя исполнитель не правит: у ядра его `after` всегда ноль, но
      // «0» и «—» говорят разное, и экран ставит прочерк.
      after: role === 'executor' ? null : roles.afterByRole[role],
    })),
    after: {
      total: afterTotal,
      rows: shown.map((role) => ({
        role,
        count: roles.afterByRole[role],
        share: part(roles.afterByRole[role], afterTotal),
      })),
      quiet: AFTER_ROLES.filter((role) => !shown.includes(role)),
    },
  }
}
