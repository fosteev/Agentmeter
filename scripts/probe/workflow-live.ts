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
 * Дальше этот файл растёт: 9.3 дописывает сюда печать `workflowReport`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  discoverSources,
  ingestAll,
  openDb,
  type Db,
  type SourceFile,
} from '../../packages/core/src/index.ts'

const DAY_MS = 86_400_000
const HEAD_LIMIT = 200
/** Допуск сверки с discovery, в процентных пунктах (бриф 9.1). */
const DISCOVERY_TOLERANCE = 0.5

const args = process.argv.slice(2)
const days = Number(flag('--days') ?? '30')
const discoveryPath = flag('--discovery')
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
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exitCode = 1
