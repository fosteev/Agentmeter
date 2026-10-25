/**
 * Разбор для экрана Workflow (9.1) на живых логах: статус вызова (`is_error`) и
 * голова последнего ответа сабагента.
 *
 *     node --experimental-strip-types scripts/probe/workflow-live.ts
 *     node --experimental-strip-types scripts/probe/workflow-live.ts --days 30 --discovery rows.json
 *
 * Два счёта одного и того же, и они намеренно не делят код. Сырой пересчёт
 * читает файлы сам — тремя правилами из брифа 9.1 — и не знает ни про парсер,
 * ни про индекс. Проба собирает индекс заново во временный каталог (живой
 * индекс приложения не открывается и не мигрируется) и сверяет с сырым счётом:
 * вызовы, ошибки, «не знаем», число сабагентов с головой и саму голову каждого.
 * Разойдись они — врёт одна из двух реализаций, и проба об этом скажет, а не
 * усреднит.
 *
 * Третий счёт — чужой: `discovery/sandbox/route-stats`, который считает долю
 * ошибок по строкам сессий. Его запускают отдельно и отдают пробе файл:
 *
 *     python3 -I ~/Projects/discovery/sandbox/route-stats/route_stats.py \
 *       --days 30 --json rows.json
 *
 * Сходиться обязано в пределах 0.5 п.п. Расхождение больше — это разбор, а не
 * подгонка: у discovery другое окно (сессии, чей корневой файл менялся за N
 * дней, целиком), он не читает сабагентов воркфлоу и считает ошибкой любое
 * истинное `is_error`; проба печатает эти три отличия числами.
 *
 * Вторая половина файла (9.3) — `workflowReport` на тех же логах: циклы, окно,
 * переделка, накладные, ошибки, вердикты, роли. Тоже два счёта. Сырой пересчёт
 * не знает про индекс и `tool_files`: дерево берёт из каталогов сабагентов,
 * записи — из `tool_use` с путём (`Edit`/`Write`/`NotebookEdit`), метку — из
 * первой строки запроса; роль — тем же `roleOf` с дефолтными правилами.
 * Расходятся числа циклов, записей по ролям или `after` — врёт одна из
 * реализаций, и проба краснеет.
 *
 *     node --experimental-strip-types scripts/probe/workflow-live.ts --cycles 10 --sessions 20
 *
 * `--cycles` и `--sessions` — размеры окон (по умолчанию из конфига: 10 и 20).
 * Числа discovery (`route_stats.py`) с этими **не обязаны** сходиться: роли там
 * угаданы по промту, а переделка — только ревьюер-агентов (нижняя граница).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_CONFIG,
  discoverSources,
  ingestAll,
  openDb,
  roleOf,
  workflowReport,
  type Db,
  type SourceFile,
  type WorkflowReport,
} from '../../packages/core/src/index.ts'

const DAY_MS = 86_400_000
const HEAD_LIMIT = 200
/** Допуск сверки с discovery, в процентных пунктах (бриф 9.1). */
const DISCOVERY_TOLERANCE = 0.5

const args = process.argv.slice(2)
const days = Number(flag('--days') ?? '30')
const discoveryPath = flag('--discovery')
const cycleWindow = Number(flag('--cycles') ?? DEFAULT_CONFIG.workflow.window.cycles)
const sessionWindow = Number(flag('--sessions') ?? DEFAULT_CONFIG.workflow.window.sessions)
const since = Date.now() - days * DAY_MS

function flag(name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

type Json = Record<string, unknown>
type Status = 'error' | 'ok' | 'unknown'

interface RawCall {
  /** Метка первой строки запроса — та же, что `requests.ts` в индексе. */
  ts: number
  status: Status
  /** Дискавери-правило: любое истинное значение. Нужно только для объяснения расхождения. */
  truthy: boolean
}

interface RawFile {
  file: SourceFile
  calls: RawCall[]
  /** Голова последнего непустого текстового блока — своей реализацией, не парсера. */
  head?: string
  /** Метка первой записи файла: окно сабагентов считается по ней. */
  firstTs: number
}

const ABSENT = Symbol('absent')

// ─── сырой пересчёт: Claude ──────────────────────────────────────────────────

function rawClaude(file: SourceFile): RawFile {
  const results = new Map<string, unknown>()
  const requests = new Map<string, { ts: number; ids: string[] }>()
  let last: string | undefined
  let firstTs = Number.POSITIVE_INFINITY

  for (const line of readFileSync(file.path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record: Json
    try {
      record = JSON.parse(line) as Json
    } catch {
      continue
    }
    const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (!Number.isNaN(stamp)) firstTs = Math.min(firstTs, stamp)
    const message = record.message as Json | undefined
    const content = Array.isArray(message?.content) ? (message.content as Json[]) : []

    if (record.type === 'assistant' && typeof record.requestId === 'string' && message) {
      let request = requests.get(record.requestId)
      if (!request) {
        request = { ts: Number.isNaN(stamp) ? 0 : stamp, ids: [] }
        requests.set(record.requestId, request)
      }
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          if (typeof block.name === 'string' && !request.ids.includes(block.id))
            request.ids.push(block.id)
        }
        if (block?.type === 'text' && typeof block.text === 'string' && /\S/.test(block.text))
          last = block.text
      }
    }

    if (record.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        // Ключа нет — успех (правило 30: в API он по умолчанию ложен); ABSENT
        // остаётся только у вызова без результата.
        results.set(block.tool_use_id, 'is_error' in block ? block.is_error : false)
      }
    }
  }

  const calls: RawCall[] = []
  for (const request of requests.values()) {
    for (const id of request.ids) {
      const value = results.has(id) ? results.get(id) : ABSENT
      calls.push({
        ts: request.ts,
        status: value === true ? 'error' : value === false ? 'ok' : 'unknown',
        truthy: value !== ABSENT && Boolean(value),
      })
    }
  }
  const raw: RawFile = { file, calls, firstTs: Number.isFinite(firstTs) ? firstTs : 0 }
  // Кодпоинты — через Array.from, а не тем циклом, что в парсере: две
  // реализации одного правила.
  if (last !== undefined) raw.head = Array.from(last).slice(0, HEAD_LIMIT).join('')
  return raw
}

interface Tally {
  calls: number
  errors: number
  ok: number
  unknown: number
}

function tally(calls: RawCall[], from = 0): Tally {
  const own = calls.filter((call) => call.ts >= from)
  return {
    calls: own.length,
    errors: own.filter((call) => call.status === 'error').length,
    ok: own.filter((call) => call.status === 'ok').length,
    unknown: own.filter((call) => call.status === 'unknown').length,
  }
}

function indexTally(db: Db, from: number): Tally {
  const row = db.get<Tally>(
    `SELECT count(*) AS calls,
            count(CASE WHEN tc.is_error = 1 THEN 1 END) AS errors,
            count(CASE WHEN tc.is_error = 0 THEN 1 END) AS ok,
            count(CASE WHEN tc.is_error IS NULL THEN 1 END) AS unknown
     FROM tool_calls tc
     JOIN requests r ON r.session_id = tc.session_id AND r.seq = tc.seq
     JOIN sessions s ON s.id = tc.session_id
     WHERE s.provider = 'claude' AND r.ts >= ?`,
    from,
  )
  return row ?? { calls: 0, errors: 0, ok: 0, unknown: 0 }
}

// ─── срез discovery ──────────────────────────────────────────────────────────

/**
 * Счёт по правилам `route_stats.py` на его же срезе. Нужен только затем, чтобы
 * показать, откуда берётся его число, если оно разойдётся с индексом: окно у
 * него другое (корень, чей файл менялся за N дней, целиком), воркфлоу-сабагентов
 * в нём нет, а ошибка — любое истинное `is_error`, без дедупа по `requestId`.
 */
function discoveryCut(
  all: SourceFile[],
  from: number,
): { roots: number; calls: number; errors: number } {
  const roots = all.filter((file) => file.kind === 'session' && statSync(file.path).mtimeMs >= from)
  let calls = 0
  let errors = 0
  const add = (path: string, skipSidechain: boolean): void => {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      let record: Json
      try {
        record = JSON.parse(line) as Json
      } catch {
        continue
      }
      if (skipSidechain && record.isSidechain) continue
      const message = record.message as Json | undefined
      const content = Array.isArray(message?.content) ? (message.content as Json[]) : []
      for (const block of content) {
        if (record.type === 'user' && block?.type === 'tool_result' && block.is_error) errors += 1
        if (record.type === 'assistant' && block?.type === 'tool_use') calls += 1
      }
    }
  }
  for (const root of roots) {
    add(root.path, true)
    const direct = join(dirname(root.path), basename(root.path, '.jsonl'), 'subagents')
    for (const file of all)
      if (file.kind === 'subagent' && dirname(file.path) === direct) add(file.path, false)
  }
  return { roots: roots.length, calls, errors }
}

// ─── вывод ───────────────────────────────────────────────────────────────────

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(3)}%`
}

function describe(label: string, value: Tally): string {
  return (
    `${label}: вызовов ${value.calls}, ошибок ${value.errors} (${pct(value.errors, value.calls)}), ` +
    `успехов ${value.ok}, без статуса ${value.unknown} (${pct(value.unknown, value.calls)}); ` +
    `к известным ${pct(value.errors, value.errors + value.ok)}`
  )
}

function same(a: Tally, b: Tally): boolean {
  return a.calls === b.calls && a.errors === b.errors && a.ok === b.ok && a.unknown === b.unknown
}

let failed = false
function report(n: number, name: string, detail: string, ok: boolean): void {
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${n}. ${name}: ${detail}`)
}

// ─── workflowReport: сырой пересчёт (9.3) ────────────────────────────────────

const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}
const ROLES = ['main', 'executor', 'reviewer', 'planner', 'explore', 'unknown'] as const
type Role = (typeof ROLES)[number]

interface RawNode {
  id: string
  type: string | null
  /** Метка первого запроса; `NaN` — запросов нет. */
  start: number
  requests: number
  writes: number[]
}

function zeroRoles(): Record<Role, number> {
  return { main: 0, executor: 0, reviewer: 0, planner: 0, explore: 0, unknown: 0 }
}

/** Файл транскрипта → запросы и записи; ничего не знает ни про индекс, ни про `tool_files`. */
function rawNode(file: SourceFile): RawNode {
  const first = new Map<string, number>()
  const tools: Array<{ request: string; name: string; path: unknown }> = []
  const seen = new Set<string>()
  for (const line of readFileSync(file.path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record: Json
    try {
      record = JSON.parse(line) as Json
    } catch {
      continue
    }
    if (record.type !== 'assistant' || typeof record.requestId !== 'string') continue
    const message = record.message as Json | undefined
    if (!message) continue
    const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (!first.has(record.requestId)) first.set(record.requestId, Number.isNaN(stamp) ? 0 : stamp)
    const content = Array.isArray(message.content) ? (message.content as Json[]) : []
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string')
        continue
      if (seen.has(block.id)) continue
      seen.add(block.id)
      const key = WRITE_TOOLS[block.name]
      if (key === undefined) continue
      tools.push({ request: record.requestId, name: block.name, path: (block.input as Json | undefined)?.[key] })
    }
  }
  const stem = basename(file.path, '.jsonl')
  let type: string | null = null
  if (file.kind === 'subagent') {
    try {
      const meta = JSON.parse(readFileSync(`${file.path.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8')) as Json
      type = typeof meta.agentType === 'string' && meta.agentType !== '' ? meta.agentType : null
    } catch {
      type = null
    }
  }
  return {
    id: file.kind === 'subagent' ? stem.replace(/^agent-/, '') : stem,
    type,
    start: first.size === 0 ? Number.NaN : first.values().next().value!,
    requests: first.size,
    writes: tools
      .filter((tool) => typeof tool.path === 'string' && tool.path.length > 0)
      .map((tool) => first.get(tool.request) ?? 0),
  }
}

interface RawCycle {
  id: string
  started: number
  writes: Record<Role, number>
  after: Record<Role, number>
}

/** Циклы из сырых файлов: корень, чей каталог содержит сабагента с ролью исполнителя. */
function rawCycles(all: SourceFile[]): RawCycle[] {
  const childrenOf = new Map<string, SourceFile[]>()
  for (const file of all)
    if (file.kind === 'subagent' && file.parentPath !== undefined) {
      const list = childrenOf.get(file.parentPath) ?? []
      list.push(file)
      childrenOf.set(file.parentPath, list)
    }
  const out: RawCycle[] = []
  for (const root of all.filter((file) => file.kind === 'session')) {
    const children = (childrenOf.get(root.path) ?? []).map((file) => rawNode(file))
    const role = (node: RawNode): Role => roleOf(node.type, DEFAULT_CONFIG.workflow.roles)
    const executors = children.filter((node) => role(node) === 'executor')
    if (executors.length === 0) continue
    const main = rawNode(root)
    const worked = executors.filter((node) => node.requests > 0).map((node) => node.start)
    const boundary = worked.length === 0 ? null : Math.min(...worked)
    const cycle: RawCycle = { id: main.id, started: main.start, writes: zeroRoles(), after: zeroRoles() }
    const nodes: Array<[RawNode, Role]> = [
      [main, 'main'],
      ...children.map((node): [RawNode, Role] => [node, role(node)]),
    ]
    for (const [node, kind] of nodes) {
      cycle.writes[kind] += node.writes.length
      if (kind !== 'executor' && boundary !== null)
        cycle.after[kind] += node.writes.filter((ts) => ts >= boundary).length
    }
    out.push(cycle)
  }
  return out.sort((a, b) => a.started - b.started || (a.id < b.id ? -1 : 1))
}

// ─── workflowReport: вывод (9.3) ─────────────────────────────────────────────

function share(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function show(report: WorkflowReport['rework'], unit: 'share' | 'times'): string {
  // `≈` — только у накладных: они считаются токенами, а восстановленные запросы
  // (1.3) в токенах не точны; доля записей и доля ошибок от них не зависят.
  const text = (point: { value: number; numerator: number; denominator: number; approximate: boolean } | null): string =>
    point === null
      ? '—'
      : `${unit === 'share' ? share(point.value) : `×${point.value.toFixed(2)}${point.approximate ? ' ≈' : ''}`} (${point.numerator}/${point.denominator})`
  const delta =
    report.delta === null
      ? 'дельты нет'
      : unit === 'share'
        ? `${report.delta >= 0 ? '+' : ''}${(report.delta * 100).toFixed(1)} п.п.`
        : `${report.delta >= 0 ? '+' : ''}${report.delta.toFixed(2)}`
  return `последнее ${text(report.latest)}; перед ним ${text(report.prev)}; ${delta}; всего ${report.count}, окно ${report.size}`
}

function printWorkflow(db: Db, all: SourceFile[]): void {
  const config = { ...DEFAULT_CONFIG.workflow, window: { cycles: cycleWindow, sessions: sessionWindow } }
  const wf = workflowReport(db, { config })
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

  console.log(`\n── workflowReport · окно ${cycleWindow} циклов / ${sessionWindow} сессий ──`)
  console.log(
    `циклов ${wf.cycles.length}` +
      (wf.cycles.length > 0
        ? `, с ${day(wf.cycles[0]!.startedAt)} по ${day(wf.cycles.at(-1)!.startedAt)}`
        : '') +
      `; восстановленные запросы в ${wf.cycles.filter((cycle) => cycle.inherited).length}; ` +
      `emptyIndex ${wf.emptyIndex}, emptyScope ${wf.emptyScope}`,
  )
  const unknownTypes = new Map<string, number>()
  for (const row of db.all<{ type: string | null }>(
    `SELECT agent_type AS type FROM sessions WHERE is_sidechain = 1`,
  )) {
    const role = roleOf(row.type, DEFAULT_CONFIG.workflow.roles)
    if (role === 'unknown') unknownTypes.set(row.type ?? '—', (unknownTypes.get(row.type ?? '—') ?? 0) + 1)
  }
  console.log(
    `роль не определена у сабагентов: ${[...unknownTypes.entries()].map(([type, n]) => `${type} ${n}`).join(', ') || 'нет'}`,
  )
  console.log(
    `переделка:  ${show(wf.rework, 'share')}; исключено циклов без видимых записей исполнителя: ` +
      `в последнем ${wf.rework.latest?.unseen ?? '—'}, перед ним ${wf.rework.prev?.unseen ?? '—'}, ` +
      `всего ${wf.cycles.filter((cycle) => cycle.executorUnseen).length} из ${wf.cycles.length}`,
  )
  console.log(`накладные:  ${show(wf.overhead, 'times')}`)
  console.log(`ошибки:     ${show(wf.errorRate, 'share')}`)
  const verdict = wf.verdicts.latest
  console.log(
    `вердикты:   доля «с оговорками + не принят» ${share(verdict?.value ?? null)}` +
      (verdict === null
        ? ''
        : ` — принят ${verdict.counts.accepted}, с оговорками ${verdict.counts.notes}, не принят ${verdict.counts.rejected}, нет ${verdict.counts.none}`) +
      `; перед ним ${share(wf.verdicts.prev?.value ?? null)}`,
  )
  console.log(
    `ряд переделки (n:значение): ${wf.rework.points.map((point) => `${point.n}:${share(point.value)}`).join(' ') || 'окно не набралось'}`,
  )
  console.log(
    `ряд накладных:             ${wf.overhead.points.map((point) => `${point.n}:×${point.value.toFixed(2)}`).join(' ') || '—'}`,
  )

  // Каждый цикл строкой: это то, что экран покажет подсказкой над точкой графика.
  console.log('\nциклы по порядку: дата · проект · записи исполнителя / after (по ролям) · накладные · вердикты')
  wf.cycles.forEach((cycle, index) => {
    const after = ROLES.filter((role) => cycle.writesAfter[role] > 0).map((role) => `${role} ${cycle.writesAfter[role]}`)
    const executor = cycle.spend.executor
    console.log(
      `  ${String(index + 1).padStart(2)} ${day(cycle.startedAt)} ${cycle.project.padEnd(14)}` +
        ` ex ${String(cycle.writes.executor).padStart(3)} / after ${String(ROLES.reduce((acc, role) => acc + cycle.writesAfter[role], 0)).padStart(3)}` +
        ` (${after.join(', ') || '—'})${cycle.executorUnseen ? ' исполнитель невидим' : ''}` +
        `  ${executor === 0 ? '—' : `×${((cycle.spend.main + cycle.spend.reviewer) / executor).toFixed(2)}`}${cycle.inherited ? ' ≈' : ''}` +
        `  ${cycle.verdicts.join(',') || '—'}`,
    )
  })

  // Роли последнего окна и все циклы за всё время.
  const total = (values: Record<Role, number>): number => ROLES.reduce((acc, role) => acc + values[role], 0)
  console.log(
    `\nроли последнего окна (${wf.roles.cycles} циклов, из них с невидимым исполнителем ${wf.roles.unseen} — ` +
      'их расход есть, записей нет): расход / записи / из них after',
  )
  for (const role of ROLES) {
    console.log(
      `  ${role.padEnd(9)} ${String(wf.roles.spend[role]).padStart(12)} ${share(total(wf.roles.spend) === 0 ? null : wf.roles.spend[role] / total(wf.roles.spend)).padStart(6)}` +
        `  записей ${String(wf.roles.writes[role]).padStart(4)}  after ${String(wf.roles.afterByRole[role]).padStart(4)}`,
    )
  }
  const whole = zeroRoles()
  const wholeAfter = zeroRoles()
  const seenWhole = zeroRoles()
  const seenAfter = zeroRoles()
  for (const cycle of wf.cycles)
    for (const role of ROLES) {
      whole[role] += cycle.writes[role]
      wholeAfter[role] += cycle.writesAfter[role]
      if (cycle.executorUnseen) continue
      seenWhole[role] += cycle.writes[role]
      seenAfter[role] += cycle.writesAfter[role]
    }
  const after = total(wholeAfter)
  console.log(
    `за все циклы: записей исполнителей ${whole.executor}, after ${after} (${ROLES.filter((role) => wholeAfter[role] > 0).map((role) => `${role} ${wholeAfter[role]}`).join(', ')}) ` +
      `→ переделка ${share(whole.executor + after === 0 ? null : after / (whole.executor + after))}; ` +
      `только ревьюер-агенты, как у discovery (нижняя граница): ${share(whole.executor + whole.reviewer === 0 ? null : whole.reviewer / (whole.executor + whole.reviewer))}`,
  )
  console.log(
    `  без циклов с невидимым исполнителем (так считает отчёт): записей исполнителей ${seenWhole.executor}, after ${total(seenAfter)} ` +
      `→ переделка ${share(seenWhole.executor + total(seenAfter) === 0 ? null : total(seenAfter) / (seenWhole.executor + total(seenAfter)))}`,
  )
  console.log(
    `вызовы в циклах: ${wf.cycles.reduce((acc, cycle) => acc + cycle.toolCalls, 0)}, ` +
      `ошибок ${wf.cycles.reduce((acc, cycle) => acc + cycle.toolErrors, 0)}, ` +
      `с известным статусом ${wf.cycles.reduce((acc, cycle) => acc + cycle.toolErrorsKnown, 0)}`,
  )

  // Сверка с сырым пересчётом.
  const raw = rawCycles(all)
  const rawIds = raw.map((cycle) => cycle.id)
  const indexIds = wf.cycles.map((cycle) => cycle.sessionId)
  const missing = rawIds.filter((id) => !indexIds.includes(id))
  const extra = indexIds.filter((id) => !rawIds.includes(id))
  report(
    9,
    'циклы из сырых файлов совпадают с индексом',
    `сырых ${raw.length}, в отчёте ${indexIds.length}` +
      (missing.length > 0 ? `; нет в отчёте: ${missing.slice(0, 5).join(', ')}` : '') +
      (extra.length > 0 ? `; лишние в отчёте: ${extra.slice(0, 5).join(', ')}` : ''),
    missing.length === 0 && extra.length === 0,
  )
  const rawWrites = zeroRoles()
  const rawAfter = zeroRoles()
  for (const cycle of raw)
    for (const role of ROLES) {
      rawWrites[role] += cycle.writes[role]
      rawAfter[role] += cycle.after[role]
    }
  const sameWrites = ROLES.every((role) => rawWrites[role] === whole[role])
  const sameAfter = ROLES.every((role) => rawAfter[role] === wholeAfter[role])
  report(
    10,
    'записи по ролям совпадают с сырыми логами',
    ROLES.map((role) => `${role} ${whole[role]}/${rawWrites[role]}`).join(', ') + ' (индекс/сырые)',
    sameWrites,
  )
  report(
    11,
    'after по ролям совпадает с сырыми логами',
    ROLES.map((role) => `${role} ${wholeAfter[role]}/${rawAfter[role]}`).join(', ') + ' (индекс/сырые)',
    sameAfter,
  )
  // Последнее окно переделки — теми же суммами из сырых циклов; цикл без видимых
  // записей исполнителя в переделку не входит (приёмка 9.3).
  const lastWindow = raw.slice(-cycleWindow)
  if (lastWindow.length === cycleWindow) {
    const seen = lastWindow.filter((cycle) => cycle.writes.executor > 0)
    const num = seen.reduce((acc, cycle) => acc + total(cycle.after), 0)
    const den = seen.reduce((acc, cycle) => acc + cycle.writes.executor + total(cycle.after), 0)
    const latest = wf.rework.latest
    report(
      12,
      'переделка последнего окна из сырых логов равна отчёту',
      `${num}/${den} против ${latest === null ? 'нет точки' : `${latest.numerator}/${latest.denominator}`}`,
      den === 0 ? latest === null : latest !== null && latest.numerator === num && latest.denominator === den,
    )
  } else {
    console.log(`окно не набралось: ${lastWindow.length} из ${cycleWindow} циклов — переделка последнего окна не сверялась`)
  }
}

// ─── прогон ──────────────────────────────────────────────────────────────────

const files = discoverSources({}).filter((file) => file.provider === 'claude')
const raws = files.map(rawClaude)
const rawCalls = raws.flatMap((raw) => raw.calls)
const rawSubagents = raws.filter((raw) => raw.file.kind === 'subagent')

const temp = mkdtempSync(join(tmpdir(), 'agentmeter-workflow-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const stats = ingestAll(db)
  console.log(
    `файлов Claude ${files.length} (сабагентов ${rawSubagents.length}), индекс: сессий ${stats.sessions}, ` +
      `запросов ${stats.requests}; окно ${days} дн. с ${new Date(since).toISOString().slice(0, 10)}`,
  )

  // ─── статусы вызовов ─────────────────────────────────────────────────────
  const indexWindow = indexTally(db, since)
  const rawWindow = tally(rawCalls, since)
  const indexAll = indexTally(db, 0)
  const rawAll = tally(rawCalls)
  console.log(describe('индекс, окно', indexWindow))
  console.log(describe('сырые, окно ', rawWindow))
  console.log(describe('индекс, всё  ', indexAll))
  report(
    1,
    'индекс сходится с сырыми логами (окно)',
    `${same(indexWindow, rawWindow)}`,
    same(indexWindow, rawWindow),
  )
  report(
    2,
    'индекс сходится с сырыми логами (весь период)',
    `${same(indexAll, rawAll)}`,
    same(indexAll, rawAll),
  )

  // Доля по Bash и по остальным раздельно: ошибки у них разной природы
  // (команда упала против отказа инструмента), и смешанное число не говорит,
  // откуда рост. «Не знаем» — только вызовы без результата и не булев ключ.
  const byTool = db.all<{ bash: number; status: number | null; n: number }>(
    `SELECT tc.name = 'Bash' AS bash, tc.is_error AS status, count(*) AS n
     FROM tool_calls tc
     JOIN requests r ON r.session_id = tc.session_id AND r.seq = tc.seq
     JOIN sessions s ON s.id = tc.session_id
     WHERE s.provider = 'claude' AND r.ts >= ? GROUP BY 1, 2`,
    since,
  )
  for (const [label, isBash] of [
    ['Bash     ', 1],
    ['остальные', 0],
  ] as const) {
    const own = byTool.filter((row) => row.bash === isBash)
    const count = (status: number | null): number =>
      own.filter((row) => row.status === status).reduce((sum, row) => sum + row.n, 0)
    const total = own.reduce((sum, row) => sum + row.n, 0)
    console.log(
      `  ${label}: вызовов ${total}, ошибок ${count(1)} (${pct(count(1), total)}), ` +
        `успехов ${count(0)}, не знаем ${count(null)} (${pct(count(null), total)})`,
    )
  }

  const codex = db.get<{ calls: number; known: number }>(
    `SELECT count(*) AS calls, count(tc.is_error) AS known
     FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id WHERE s.provider = 'codex'`,
  )!
  report(
    3,
    'у Codex статуса нет ни у одного вызова',
    `вызовов ${codex.calls}, со статусом ${codex.known}`,
    codex.known === 0,
  )

  // ─── голова последнего ответа сабагента ──────────────────────────────────
  const indexSubagents = db.all<{ id: string; head: string | null; started: number }>(
    `SELECT id, last_text_head AS head, started_at AS started FROM sessions
     WHERE provider = 'claude' AND is_sidechain = 1`,
  )
  const withHead = indexSubagents.filter((row) => row.head !== null)
  const rawWithHead = rawSubagents.filter((raw) => raw.head !== undefined)
  const rawById = new Map(
    rawSubagents.map((raw) => [basename(raw.file.path, '.jsonl').replace(/^agent-/, ''), raw]),
  )
  const broken: string[] = []
  for (const row of indexSubagents) {
    const raw = rawById.get(row.id)
    if (!raw) broken.push(`${row.id}: в индексе есть, файла нет`)
    else if ((row.head ?? undefined) !== raw.head) broken.push(`${row.id}: голова разошлась`)
  }
  const lengths = withHead.map((row) => Array.from(row.head!).length)
  const recent = indexSubagents.filter((row) => row.started >= since)
  console.log(
    `сабагентов в индексе ${indexSubagents.length}, с головой ${withHead.length} ` +
      `(за ${days} дн.: ${recent.filter((row) => row.head !== null).length} из ${recent.length}); ` +
      `в сырых логах с текстом ${rawWithHead.length} из ${rawSubagents.length}`,
  )
  report(
    4,
    'голова сходится с сырыми логами у каждого сабагента',
    `сверено ${indexSubagents.length}, расхождений ${broken.length}` +
      (broken.length > 0 ? `\n      ${broken.slice(0, 5).join('\n      ')}` : ''),
    broken.length === 0 && indexSubagents.length === rawSubagents.length,
  )
  const roots = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM sessions WHERE is_sidechain = 0 AND last_text_head IS NOT NULL`,
  )!.n
  report(5, 'у корневых сессий головы нет', `с головой ${roots}`, roots === 0)
  report(
    6,
    'голова не длиннее 200 кодпоинтов и не рвёт пару',
    `максимум ${Math.max(0, ...lengths)}, битых ${withHead.filter((row) => !row.head!.isWellFormed()).length}`,
    Math.max(0, ...lengths) <= HEAD_LIMIT && withHead.every((row) => row.head!.isWellFormed()),
  )
  const types = db.all<{ type: string | null; total: number; heads: number }>(
    `SELECT agent_type AS type, count(*) AS total, count(last_text_head) AS heads
     FROM sessions WHERE provider = 'claude' AND is_sidechain = 1
     GROUP BY agent_type ORDER BY total DESC LIMIT 8`,
  )
  console.log(
    `  по agentType: ${types.map((row) => `${row.type ?? '—'} ${row.heads}/${row.total}`).join(', ')}`,
  )

  // ─── сверка с discovery ──────────────────────────────────────────────────
  if (discoveryPath === undefined) {
    console.log(
      '\nсверка с discovery не запрошена: --discovery <rows.json> из ' +
        'route_stats.py --days 30 --json rows.json',
    )
  } else {
    const rows = JSON.parse(readFileSync(discoveryPath, 'utf8')) as Array<{
      tool_errors: number
      tool_calls: number
    }>
    const errors = rows.reduce((sum, row) => sum + row.tool_errors, 0)
    const calls = rows.reduce((sum, row) => sum + row.tool_calls, 0)
    const theirs = (errors / calls) * 100
    const ours = (indexWindow.errors / indexWindow.calls) * 100
    console.log(
      `\ndiscovery: сессий ${rows.length}, вызовов ${calls}, ошибок ${errors} (${theirs.toFixed(3)}%)`,
    )
    console.log(
      `проба:     вызовов ${indexWindow.calls}, ошибок ${indexWindow.errors} (${ours.toFixed(3)}%)`,
    )
    const workflowCalls = raws
      .filter((raw) => raw.file.kind === 'subagent' && raw.file.path.includes('/workflows/'))
      .flatMap((raw) => raw.calls)
    const workflowWindow = tally(workflowCalls, since)
    const truthyNotTrue = rawCalls.filter(
      (call) => call.ts >= since && call.truthy && call.status !== 'error',
    ).length
    console.log(
      `  отличия от discovery: сабагенты воркфлоу (он их не читает) — в окне ${workflowWindow.calls} вызовов, ` +
        `${workflowWindow.errors} ошибок; истинное, но не булево is_error — ${truthyNotTrue}`,
    )
    const cut = discoveryCut(files, since)
    const cutShare = (cut.errors / cut.calls) * 100
    console.log(
      `  срез discovery из сырых логов: корней ${cut.roots} (у него ${rows.length}: сессии с нулевой ` +
        `оценкой стоимости он отбрасывает), вызовов ${cut.calls}, ошибок ${cut.errors} (${cutShare.toFixed(3)}%)`,
    )
    report(
      7,
      `доля ошибок сходится с discovery в пределах ${DISCOVERY_TOLERANCE} п.п.`,
      `разница ${(ours - theirs).toFixed(3)} п.п.`,
      Math.abs(ours - theirs) <= DISCOVERY_TOLERANCE,
    )
    report(
      8,
      'правила discovery воспроизведены: его срез из сырых логов даёт его долю',
      `разница ${(cutShare - theirs).toFixed(3)} п.п.`,
      Math.abs(cutShare - theirs) <= 0.1,
    )
  }

  // ─── workflowReport (9.3) ────────────────────────────────────────────────
  printWorkflow(db, files)
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exitCode = 1
