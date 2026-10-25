/**
 * Агрегат экрана Workflow (9.3): какие сессии — циклы «план → исполнитель →
 * приёмка», кто в цикле сколько потратил и сколько записал, какая доля переделки
 * в окне последних N циклов и какой она была в окне до него.
 *
 * Одна функция на все вопросы экрана, потому что у них общий скелет — дерево
 * цикла, роль каждого узла, окно, — и разъехаться им нельзя: «накладные» с
 * другим понятием цикла, чем «переделка», были бы двумя правдами на одном экране.
 *
 * **Окно считает суммы, а не усредняет доли.** Значение точки — сумма числителей
 * окна, делённая на сумму знаменателей: цикл на пятнадцать записей весит в доле
 * переделки втрое больше цикла на пять. Усреднение долей отдало бы короткому
 * циклу тот же голос, что длинному, и на живых логах давало бы 0% и 100% на
 * соседних неделях (discovery: «неделя с двумя циклами дала 8%»). Точка с нулевым
 * знаменателем пропускается, а не становится нулём: «правок не было» и «правок
 * ноль из нуля» — разные утверждения.
 *
 * **Переделка — по записям файлов, а не по деньгам.** Числитель — записи
 * (`tool_files.action = 'write'`) всех узлов цикла, кроме исполнителей, с меткой
 * запроса не раньше старта первого исполнителя; знаменатель — они же плюс записи
 * исполнителей. Ревьюером цикл не ограничен: в цикле `/plan` приёмка идёт в
 * главной сессии, и её правки иначе пропали бы. Правки через `Bash` (`sed`,
 * `git apply`, `python3 - <<EOF`) не видны — шелл не разбирается
 * (`sources/files.ts`).
 *
 * **Цикл, где исполнитель не оставил ни одной видимой записи, в переделку не
 * входит** (`executorUnseen`) и называется числом в точке (`unseen`). Такой цикл
 * даёт `0 / after` — 100% без единого исключения, — хотя исполнитель обычно писал,
 * только шеллом: на живых логах так 4 цикла из 7 (приёмка 9.3). Это не оценка, а
 * число без знаменателя, поэтому `≈` тут не помощник: цикл исключается, а экран
 * говорит, сколько исключено. Частичная невидимость (исполнитель правил и
 * `Edit`-ом, и шеллом) остаётся поправкой в подвале.
 *
 * Роль — только по `agentType` и только из правил пользователя (`roleOf`).
 * Неопределённый субагент (`general-purpose`) — `unknown`, и исполнителем он не
 * становится ни здесь, ни в знаменателе: приписать ему чужие записи значило бы
 * выдумать знаменатель.
 */
import type { Verdict, WorkflowConfig } from '../config/types.ts'
import type { Db } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { roleOf, verdictOf } from '../workflow/roles.ts'
import { SPEND } from './matrix.ts'
import { taskSessions } from './task.ts'
import { sourceCount } from './today.ts'
import type {
  RequestScope,
  RoleNumbers,
  WorkflowCycle,
  WorkflowNodeRole,
  WorkflowPoint,
  WorkflowReport,
  WorkflowReworkPoint,
  WorkflowRoles,
  WorkflowSeries,
  WorkflowVerdictPoint,
} from './types.ts'

export interface WorkflowOptions {
  /** `Config['workflow']`: роли, регулярки вердикта, размеры окон. `enabled` агрегат не читает — это забота экрана. */
  config: WorkflowConfig
  /** Сужение. Проект и провайдер берутся у **корня**, сабагенты идут за ним. */
  scope?: RequestScope
  /**
   * Верхняя граница (строго раньше) по началу корня: дерево берётся целиком, как
   * оно лежит в индексе. Нужна тестам — чтобы получить «индекс на такой-то момент»
   * без второго набора логов.
   */
  until?: number
}

/** Порядок ролей в ответе и на экране: главная сессия первой, `unknown` последним. */
export const WORKFLOW_ROLES: readonly WorkflowNodeRole[] = [
  'main',
  'executor',
  'reviewer',
  'planner',
  'explore',
  'unknown',
]

interface SessionRow {
  id: string
  parent_session_id: string | null
  is_sidechain: number
  agent_type: string | null
  project: string
  provider: Provider
  started_at: number
  last_text_head: string | null
}

/** Всё, что индекс знает о сессии помимо самой строки, — тремя проходами по таблицам, а не по запросу на сессию. */
interface SessionStats {
  spend: number
  requests: number
  /** Запросов с `origin != 'log'` (1.3). */
  reconstructed: number
  calls: number
  errors: number
  /** Вызовы с известным статусом — `count(is_error)`. */
  known: number
  /** Метки запросов, в которых случилась запись файла: по строке на строку `tool_files`. */
  writes: number[]
}

const NO_STATS: SessionStats = {
  spend: 0,
  requests: 0,
  reconstructed: 0,
  calls: 0,
  errors: 0,
  known: 0,
  writes: [],
}

export function workflowReport(db: Db, opts: WorkflowOptions): WorkflowReport {
  const { config, scope = {}, until } = opts
  const cycleSize = windowSize(config.window.cycles)
  const sessionSize = windowSize(config.window.sessions)

  const rows = db.all<SessionRow>(
    `SELECT id, parent_session_id, is_sidechain, agent_type, project, provider, started_at,
            last_text_head
     FROM sessions`,
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  const stats = loadStats(db)

  // ── деревья ──────────────────────────────────────────────────────────────
  // Корень — `is_sidechain = 0`. Дерево — `taskSessions` (одно на карточку задачи,
  // ленту и этот отчёт): оно защищено от цикла в `parent_session_id` через
  // `UNION`, и заменять его на `UNION ALL` нельзя.
  const roots = rows.filter((row) => row.is_sidechain === 0).sort(byStart)
  const hasChildren = new Set(
    rows.flatMap((row) => (row.parent_session_id === null ? [] : [row.parent_session_id])),
  )
  const trees = new Map<string, SessionRow[]>()
  const owner = new Map<string, SessionRow>()
  for (const root of roots) owner.set(root.id, root)
  for (const root of roots) {
    const ids = hasChildren.has(root.id) ? taskSessions(db, root.id) : [root.id]
    const nodes = ids.flatMap((id) => {
      const node = byId.get(id)
      return node === undefined ? [] : [node]
    })
    trees.set(root.id, nodes.sort(byStart))
    for (const node of nodes) if (!owner.has(node.id)) owner.set(node.id, root)
  }

  const inScope = (row: SessionRow): boolean =>
    (scope.provider === undefined || row.provider === scope.provider) &&
    (scope.project === undefined || row.project === scope.project)
  const early = (row: SessionRow): boolean => until === undefined || row.started_at < until

  // ── циклы ────────────────────────────────────────────────────────────────
  const built = roots.filter(early).flatMap((root) => {
    const cycle = buildCycle(root, trees.get(root.id) ?? [root], stats, config)
    return cycle === null ? [] : [{ root, cycle }]
  })
  const cycles = built.filter(({ root }) => inScope(root)).map(({ cycle }) => cycle)

  const rework = rolling(
    cycles,
    cycleSize,
    (cycle) => {
      if (cycle.executorUnseen) return { numerator: 0, denominator: 0 }
      const after = sum(Object.values(cycle.writesAfter))
      return { numerator: after, denominator: cycle.writes.executor + after }
    },
    NOT_TOKENS,
    (window, point): WorkflowReworkPoint => ({
      ...point,
      unseen: window.filter((cycle) => cycle.executorUnseen).length,
    }),
  )
  // `≈` — только здесь: восстановленный запрос (1.3) меняет расход, но не записи,
  // не вызовы и не вердикты — вызовов у таких запросов нет (на живом индексе 0).
  const overhead = rolling(
    cycles,
    cycleSize,
    (cycle) => ({
      numerator: cycle.spend.main + cycle.spend.reviewer,
      denominator: cycle.spend.executor,
    }),
    (window) => window.some((cycle) => cycle.inherited),
  )
  const verdicts = rolling(
    cycles,
    cycleSize,
    (cycle) => {
      const notes = countOf(cycle.verdicts, 'notes')
      const rejected = countOf(cycle.verdicts, 'rejected')
      return {
        numerator: notes + rejected,
        // «Вердикта нет» в знаменатель не идёт — как вызовы без статуса в долю ошибок.
        denominator: countOf(cycle.verdicts, 'accepted') + notes + rejected,
      }
    },
    NOT_TOKENS,
    (window, point): WorkflowVerdictPoint => ({
      ...point,
      counts: {
        accepted: sum(window.map((cycle) => countOf(cycle.verdicts, 'accepted'))),
        notes: sum(window.map((cycle) => countOf(cycle.verdicts, 'notes'))),
        rejected: sum(window.map((cycle) => countOf(cycle.verdicts, 'rejected'))),
        none: sum(window.map((cycle) => countOf(cycle.verdicts, 'none'))),
      },
    }),
  )

  // ── ошибки: окно в сессиях, а не в циклах ──────────────────────────────────
  // Сессия принадлежит проекту и провайдеру своего корня. Сирота (родителя нет в
  // индексе) — сама себе корень, как в ленте (`findRoot`).
  const sessions = rows
    .filter((row) => {
      const root = owner.get(row.id) ?? row
      return inScope(root) && early(root)
    })
    .sort(byStart)
    .map((row) => {
      const own = stats.get(row.id) ?? NO_STATS
      return {
        sessionId: row.id,
        startedAt: row.started_at,
        errors: own.errors,
        known: own.known,
      }
    })
  const errorRate = rolling(
    sessions,
    sessionSize,
    (session) => ({ numerator: session.errors, denominator: session.known }),
    NOT_TOKENS,
  )

  return {
    emptyIndex: sourceCount(db) === 0,
    emptyScope: cycles.length === 0 && built.length > 0,
    cycles,
    rework,
    overhead,
    errorRate,
    verdicts,
    roles: rolesOf(cycles.slice(Math.max(0, cycles.length - cycleSize))),
  }
}

// ─── цикл ────────────────────────────────────────────────────────────────────

function buildCycle(
  root: SessionRow,
  nodes: readonly SessionRow[],
  stats: ReadonlyMap<string, SessionStats>,
  config: WorkflowConfig,
): WorkflowCycle | null {
  // Роль корня — `main` до всяких правил: `roleOf` на `agent_type = NULL` отвечает
  // `unknown`, и вся главная сессия уехала бы в «роль не определена».
  const roleOfNode = (node: SessionRow): WorkflowNodeRole =>
    node.id === root.id ? 'main' : roleOf(node.agent_type, config.roles)

  const executors = nodes.filter((node) => roleOfNode(node) === 'executor')
  if (executors.length === 0) return null

  // Старт первого исполнителя **с работой**: у исполнителя без единого запроса
  // начала нет (`started_at` у пустого файла — ноль), и мерить от него значило бы
  // записать в переделку всё, что корень когда-либо сделал.
  const started = executors
    .filter((node) => (stats.get(node.id) ?? NO_STATS).requests > 0)
    .map((node) => node.started_at)
  const executorStartedAt = started.length === 0 ? null : Math.min(...started)

  const cycle: WorkflowCycle = {
    sessionId: root.id,
    project: root.project,
    startedAt: root.started_at,
    executorStartedAt,
    executorUnseen: false,
    spend: roleNumbers(),
    writes: roleNumbers(),
    writesAfter: roleNumbers(),
    toolCalls: 0,
    toolErrors: 0,
    toolErrorsKnown: 0,
    verdicts: [],
    inherited: false,
  }
  for (const node of nodes) {
    const role = roleOfNode(node)
    const own = stats.get(node.id) ?? NO_STATS
    cycle.spend[role] += own.spend
    cycle.writes[role] += own.writes.length
    // Исполнитель после себя не считается: его записи — знаменатель.
    if (role !== 'executor' && executorStartedAt !== null)
      cycle.writesAfter[role] += own.writes.filter((ts) => ts >= executorStartedAt).length
    cycle.toolCalls += own.calls
    cycle.toolErrors += own.errors
    cycle.toolErrorsKnown += own.known
    // Вердикт — только у ревьюера: «с оговорками» в отчёте исполнителя не приёмка.
    if (role === 'reviewer') cycle.verdicts.push(verdictOf(node.last_text_head, config.verdicts))
    if (own.reconstructed > 0) cycle.inherited = true
  }
  cycle.executorUnseen = cycle.writes.executor === 0
  return cycle
}

/**
 * Роли последнего окна: суммы по циклам. Доли — забота main (правило 13).
 *
 * Расход — по всем циклам окна, записи и `after` — только по циклам с видимым
 * исполнителем: тогда `afterByRole` в сумме равен числителю переделки последнего
 * окна, и разбивка «кто переделывает» объясняет главное число, а не соседнее.
 */
function rolesOf(cycles: readonly WorkflowCycle[]): WorkflowRoles {
  const roles: WorkflowRoles = {
    cycles: cycles.length,
    unseen: 0,
    spend: roleNumbers(),
    writes: roleNumbers(),
    afterByRole: roleNumbers(),
  }
  for (const cycle of cycles) {
    if (cycle.executorUnseen) roles.unseen += 1
    for (const role of WORKFLOW_ROLES) {
      roles.spend[role] += cycle.spend[role]
      if (cycle.executorUnseen) continue
      roles.writes[role] += cycle.writes[role]
      roles.afterByRole[role] += cycle.writesAfter[role]
    }
  }
  return roles
}

// ─── окно ────────────────────────────────────────────────────────────────────

interface Windowed {
  sessionId: string
  startedAt: number
}

/** Показатель не из токенов: восстановленные запросы (1.3) его не трогают, `≈` нет. */
const NOT_TOKENS = (): boolean => false

interface Part {
  numerator: number
  denominator: number
}

/**
 * Скользящее окно размера `size` по порядку `items`: только полные окна, точка —
 * `n` последнего элемента (с единицы).
 *
 * `latest` — окно, кончающееся на последнем элементе, `prev` — кончающееся на
 * `size` раньше (без пересечения). Если окно с нулевым знаменателем, точки нет, а
 * значит, нет и `latest`: показать вместо него прошлое окно значило бы подписать
 * «последние N циклов» над числом, которое к ним не относится.
 */
function rolling<T extends Windowed, P extends WorkflowPoint = WorkflowPoint>(
  items: readonly T[],
  size: number,
  part: (item: T) => Part,
  approximate: (window: readonly T[]) => boolean,
  decorate: (window: readonly T[], point: WorkflowPoint) => P = (_window, point) => point as P,
): WorkflowSeries<P> {
  const parts = items.map(part)
  const points: P[] = []
  for (let end = size; end <= items.length; end += 1) {
    const window = parts.slice(end - size, end)
    const numerator = sum(window.map((value) => value.numerator))
    const denominator = sum(window.map((value) => value.denominator))
    if (denominator === 0) continue
    const last = items[end - 1]
    if (last === undefined) continue
    const slice = items.slice(end - size, end)
    points.push(
      decorate(slice, {
        n: end,
        sessionId: last.sessionId,
        startedAt: last.startedAt,
        value: numerator / denominator,
        numerator,
        denominator,
        approximate: approximate(slice),
      }),
    )
  }
  const count = items.length
  const latest = points.find((point) => point.n === count) ?? null
  const prev = points.find((point) => point.n === count - size) ?? null
  return {
    size,
    count,
    points,
    latest,
    prev,
    delta: latest !== null && prev !== null ? latest.value - prev.value : null,
  }
}

// ─── чтение индекса ──────────────────────────────────────────────────────────

function loadStats(db: Db): Map<string, SessionStats> {
  const stats = new Map<string, SessionStats>()
  const of = (id: string): SessionStats => {
    let entry = stats.get(id)
    if (entry === undefined) {
      entry = { ...NO_STATS, writes: [] }
      stats.set(id, entry)
    }
    return entry
  }

  for (const row of db.all<{
    session_id: string
    spend: number
    requests: number
    reconstructed: number
  }>(
    `SELECT requests.session_id AS session_id, sum(${SPEND}) AS spend, count(*) AS requests,
            count(CASE WHEN requests.origin != 'log' THEN 1 END) AS reconstructed
     FROM requests
     GROUP BY requests.session_id`,
  )) {
    const entry = of(row.session_id)
    entry.spend = row.spend
    entry.requests = row.requests
    entry.reconstructed = row.reconstructed
  }

  // `count(is_error)` не считает `NULL`: вызовы без статуса (Codex целиком, вызов
  // Claude без результата) в знаменатель не идут (правило 30).
  for (const row of db.all<{ session_id: string; calls: number; errors: number; known: number }>(
    `SELECT tool_calls.session_id AS session_id, count(*) AS calls,
            count(CASE WHEN tool_calls.is_error = 1 THEN 1 END) AS errors,
            count(tool_calls.is_error) AS known
     FROM tool_calls
     GROUP BY tool_calls.session_id`,
  )) {
    const entry = of(row.session_id)
    entry.calls = row.calls
    entry.errors = row.errors
    entry.known = row.known
  }

  // Строки, а не разные файлы: один файл, правленный дважды, — две записи. Метка —
  // метка запроса, в котором стоит вызов (`requests.ts`), как её видит лента.
  for (const row of db.all<{ session_id: string; ts: number }>(
    `SELECT tool_files.session_id AS session_id, requests.ts AS ts
     FROM tool_files
     JOIN requests ON requests.session_id = tool_files.session_id
                  AND requests.seq = tool_files.seq
     WHERE tool_files.action = 'write'`,
  ))
    of(row.session_id).writes.push(row.ts)

  return stats
}

// ─── мелочи ──────────────────────────────────────────────────────────────────

/** Порядок один везде: время начала, при равенстве — идентификатор (не порядок вставки). */
function byStart(left: SessionRow, right: SessionRow): number {
  return (
    left.started_at - right.started_at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

function windowSize(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function roleNumbers(): RoleNumbers {
  return { main: 0, executor: 0, reviewer: 0, planner: 0, explore: 0, unknown: 0 }
}

function countOf(verdicts: readonly Verdict[], wanted: Verdict): number {
  return verdicts.filter((verdict) => verdict === wanted).length
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
