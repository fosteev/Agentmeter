/**
 * Скорость модели (8.4) на живых логах.
 *
 *     node --experimental-strip-types scripts/probe/speed-live.ts        # индекс против сырых логов
 *     node --experimental-strip-types scripts/probe/speed-live.ts --raw  # только сырые логи и замеры
 *
 * Два счёта одного и того же, и они намеренно не делят код. Сырой пересчёт
 * читает файлы сам, своими правилами границ запроса — так, как их записал
 * бриф, — и не знает ни про парсер, ни про индекс. Без `--raw` проба
 * собирает индекс заново во временный каталог (живой индекс приложения не
 * трогается) и сверяет таблицу ядра с сырой: `n` до запроса, медиану до
 * 0.1 с. Разойдись они — врёт одна из двух реализаций, и проба об этом
 * скажет, а не усреднит.
 *
 * С `--raw` печатаются ещё замеры подэтапа 1: бывают ли у Claude записи
 * между первой и последней строкой одного запроса и сколько у Codex запросов,
 * перед первым элементом ответа которых нет ни одной границы.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dayRange,
  discoverSources,
  ingestAll,
  modelSpeeds,
  openDb,
  spendMatrix,
  SPEED,
  type ModelSpeed,
  type SourceFile,
} from '../../packages/core/src/index.ts'

const RAW_ONLY = process.argv.includes('--raw')

type Json = Record<string, any>

/** Один измеренный (или неизмеримый) запрос сырого пересчёта. */
interface RawRequest {
  provider: 'claude' | 'codex'
  model: string
  output: number
  /** `undefined` — неизмерим, причина в `reason`. */
  durationMs?: number
  reason?: string
}

interface ClaudeStats {
  requests: number
  multiLine: number
  /** Запросы, между строками которых легла чужая запись с меткой. */
  interleaved: number
  interleavedTypes: Map<string, number>
  /** На скольких из них старт «перед последней строкой» дал бы другое число. */
  lastLineWouldDiffer: number
  /** Тип записи-старта: на чём держится правило. */
  startTypes: Map<string, number>
  /** Разные `output_tokens` на строках одного запроса. */
  outputVaries: number
}

interface CodexStats {
  requests: number
  duplicates: number
  /** Нет границы между прошлым запросом и первым элементом ответа. */
  noBoundary: number
  noBoundaryContext: Map<string, number>
  /** Запросы без единого элемента ответа перед `token_count`. */
  noAnswer: number
  /** `token_count` позже последнего элемента ответа на 0.5 с и больше. */
  lateTokenCount: number
  lateGapsMs: number[]
  boundaryTypes: Map<string, number>
  answerTypes: Map<string, number>
  otherItemTypes: Map<string, number>
}

const claudeStats: ClaudeStats = {
  requests: 0,
  multiLine: 0,
  interleaved: 0,
  interleavedTypes: new Map(),
  lastLineWouldDiffer: 0,
  startTypes: new Map(),
  outputVaries: 0,
}
const codexStats: CodexStats = {
  requests: 0,
  duplicates: 0,
  noBoundary: 0,
  noBoundaryContext: new Map(),
  noAnswer: 0,
  lateTokenCount: 0,
  lateGapsMs: [],
  boundaryTypes: new Map(),
  answerTypes: new Map(),
  otherItemTypes: new Map(),
}

// ─── сырой пересчёт: Claude ──────────────────────────────────────────────────

/**
 * Записи, которые CLI кладёт **перед** строкой ответа, но пишет в момент
 * ответа: стартом они быть не могут. Замер 25 октября по всем живым логам —
 * `deferred_tools_record` стоит перед первой строкой у 16 804 запросов и
 * отстоит от неё на 0–20 мс у всех 16 804; `file-history-delta` помечен
 * временем **позже** ответа у 101 из 101; `queue-operation` — сообщение,
 * поставленное в очередь, пока модель работала (у 45 из 143 позже ответа).
 * `system:api_error` пишется посреди ожидания, на каждой попытке повтора
 * (приёмка 8.4: 74 запроса), — стартом он выкинул бы повторы из ответа;
 * `api-request` — тоже на каждую попытку; `frame-link` и `pr-link` CLI
 * дописывает асинхронно.
 */
const RESPONSE_TIME = new Set([
  'attachment:deferred_tools_record',
  'file-history-delta',
  'queue-operation',
  'system:api_error',
  'api-request',
  'frame-link',
  'pr-link',
])

function claudeRecordType(record: Json): string {
  const type = String(record.type)
  if (type === 'attachment' && typeof record.attachment?.type === 'string')
    return `attachment:${record.attachment.type}`
  if (type === 'system' && typeof record.subtype === 'string') return `system:${record.subtype}`
  return type
}

function rawClaude(path: string): RawRequest[] {
  interface Draft {
    model: string
    output: number
    outputs: Set<number>
    start?: number
    startType?: string
    end?: number
    lines: number
  }
  const drafts = new Map<string, Draft>()
  let lastTs: number | undefined
  let lastType: string | undefined
  for (const line of readLines(path)) {
    const record = parse(line)
    if (!record) continue
    const ts = stamp(record)
    const rid = record.type === 'assistant' ? record.requestId : undefined
    if (typeof rid === 'string' && record.message) {
      let draft = drafts.get(rid)
      if (!draft) {
        draft = {
          model: record.message.model ?? 'unknown',
          output: 0,
          outputs: new Set(),
          ...(lastTs === undefined ? {} : { start: lastTs, startType: lastType }),
          lines: 0,
        }
        drafts.set(rid, draft)
      }
      draft.lines += 1
      const output = record.message.usage?.output_tokens
      if (typeof output === 'number') {
        draft.output = Math.max(draft.output, output)
        draft.outputs.add(output)
      }
      if (ts !== undefined) draft.end = Math.max(draft.end ?? ts, ts)
    }
    if (ts !== undefined) {
      const type = claudeRecordType(record)
      if (!RESPONSE_TIME.has(type)) {
        lastTs = ts
        lastType = type
      }
    }
  }

  const out: RawRequest[] = []
  for (const draft of drafts.values()) {
    claudeStats.requests += 1
    if (draft.lines > 1) claudeStats.multiLine += 1
    if (draft.outputs.size > 1) claudeStats.outputVaries += 1
    out.push(claudeRequest(draft))
  }
  return out

  function claudeRequest(draft: Draft): RawRequest {
    const base = { provider: 'claude' as const, model: draft.model, output: draft.output }
    if (draft.start === undefined) return { ...base, reason: 'нет записи-старта' }
    if (draft.end === undefined) return { ...base, reason: 'нет метки у строк ответа' }
    if (draft.end <= draft.start) return { ...base, reason: 'конец не позже старта' }
    bump(claudeStats.startTypes, draft.startType ?? '?')
    return { ...base, durationMs: draft.end - draft.start }
  }
}

/**
 * Записи между первой и последней строкой одного запроса — отдельным
 * проходом: считать их на лету мешает то, что «последняя строка» видна
 * только в конце файла.
 */
function claudeInterleaving(path: string): void {
  const rows: { rid?: string; ts?: number; type: string }[] = []
  for (const line of readLines(path)) {
    const record = parse(line)
    if (!record) continue
    const rid =
      record.type === 'assistant' && typeof record.requestId === 'string' && record.message
        ? record.requestId
        : undefined
    rows.push({ ...(rid ? { rid } : {}), ...optionalTs(stamp(record)), type: String(record.type) })
  }
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  rows.forEach((row, i) => {
    if (!row.rid) return
    if (!first.has(row.rid)) first.set(row.rid, i)
    last.set(row.rid, i)
  })
  for (const [rid, from] of first) {
    const to = last.get(rid)!
    if (to === from) continue
    const between = rows
      .slice(from + 1, to)
      .filter((row) => row.rid !== rid && row.ts !== undefined)
    if (between.length === 0) continue
    claudeStats.interleaved += 1
    for (const row of between) bump(claudeStats.interleavedTypes, row.type)
    // Старт по первой строке против старта по последней.
    const startFirst = lastStampBefore(rows, from)
    const startLast = lastStampBefore(rows, to)
    if (startFirst !== startLast) claudeStats.lastLineWouldDiffer += 1
  }
}

function lastStampBefore(rows: { ts?: number }[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i -= 1) if (rows[i]!.ts !== undefined) return rows[i]!.ts
  return undefined
}

// ─── сырой пересчёт: Codex ───────────────────────────────────────────────────

/** Что отдало модели промпт: после такой записи начинается ожидание. */
function codexBoundary(record: Json): string | undefined {
  const type = record.type
  const payload = record.payload ?? {}
  if (type === 'event_msg') {
    const kind = payload.type
    if (kind === 'user_message' || kind === 'task_started' || kind === 'context_compacted')
      return `event_msg/${kind}`
    return undefined
  }
  if (type === 'compacted') return 'compacted'
  if (type !== 'response_item') return undefined
  const kind = String(payload.type)
  if (kind.endsWith('_output')) return `response_item/${kind}`
  if (kind === 'message' && payload.role === 'user') return 'response_item/message:user'
  return undefined
}

/** Элемент ответа модели — то, что приходит из API, а не уходит в него. */
function codexAnswer(record: Json): string | undefined {
  if (record.type !== 'response_item') return undefined
  const payload = record.payload ?? {}
  const kind = String(payload.type)
  if (kind === 'message') return payload.role === 'assistant' ? 'message:assistant' : undefined
  if (kind.endsWith('_output')) return undefined
  return kind
}

function rawCodex(path: string): RawRequest[] {
  const out: RawRequest[] = []
  let model: string | undefined
  let lastBoundary: number | undefined
  /** Была ли граница после последнего элемента ответа — любого запроса. */
  let boundaryAfterAnswer = false
  let start: number | undefined
  let end: number | undefined
  let lastTotal: string | undefined
  let previousEvent = 'начало файла'
  for (const line of readLines(path)) {
    const record = parse(line)
    if (!record) continue
    const ts = stamp(record)
    if (record.type === 'turn_context' && typeof record.payload?.model === 'string')
      model = record.payload.model
    // Ход кончился или начался, а начатый ответ `token_count` не получил: его
    // старт не должен достаться следующему запросу через голову человека.
    if (
      record.type === 'event_msg' &&
      ['turn_aborted', 'task_complete', 'task_started', 'user_message'].includes(
        String(record.payload?.type),
      )
    ) {
      start = undefined
      end = undefined
    }
    const boundary = codexBoundary(record)
    if (boundary !== undefined) {
      bump(codexStats.boundaryTypes, boundary)
      if (ts !== undefined) lastBoundary = ts
      boundaryAfterAnswer = true
      previousEvent = boundary
      continue
    }
    const answer = codexAnswer(record)
    if (answer !== undefined) {
      bump(codexStats.answerTypes, answer)
      if (start === undefined && end === undefined) {
        if (!boundaryAfterAnswer) {
          codexStats.noBoundary += 1
          bump(codexStats.noBoundaryContext, previousEvent)
        }
        start = lastBoundary
        // Старт уже взят — дальнейшие границы этого хода его не двигают.
        if (start === undefined) start = Number.NaN
      }
      if (ts !== undefined) end = Math.max(end ?? ts, ts)
      boundaryAfterAnswer = false
      previousEvent = answer
      continue
    }
    if (record.type === 'response_item')
      bump(codexStats.otherItemTypes, String(record.payload?.type))
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      const info = record.payload.info
      if (!info?.last_token_usage) continue
      const total = JSON.stringify([
        info.total_token_usage?.input_tokens,
        info.total_token_usage?.cached_input_tokens,
        info.total_token_usage?.output_tokens,
        info.total_token_usage?.reasoning_output_tokens,
      ])
      if (info.total_token_usage && total === lastTotal) {
        codexStats.duplicates += 1
        continue
      }
      if (info.total_token_usage) lastTotal = total
      codexStats.requests += 1
      const base = {
        provider: 'codex' as const,
        model: model ?? 'unknown',
        output: info.last_token_usage.output_tokens ?? 0,
      }
      if (end === undefined) {
        codexStats.noAnswer += 1
        out.push({ ...base, reason: 'нет элемента ответа' })
      } else if (start === undefined || Number.isNaN(start)) {
        out.push({ ...base, reason: 'нет записи-старта' })
      } else if (end <= start) {
        out.push({ ...base, reason: 'конец не позже старта' })
      } else {
        out.push({ ...base, durationMs: end - start })
      }
      if (end !== undefined && ts !== undefined && ts - end >= 500) {
        codexStats.lateTokenCount += 1
        codexStats.lateGapsMs.push(ts - end)
      }
      start = undefined
      end = undefined
      previousEvent = 'token_count'
    }
  }
  return out
}

// ─── общее ───────────────────────────────────────────────────────────────────

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n')
}

function parse(line: string): Json | undefined {
  if (!line.trim()) return undefined
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Json) : undefined
  } catch {
    return undefined
  }
}

function stamp(record: Json): number | undefined {
  if (typeof record.timestamp !== 'string') return undefined
  const value = Date.parse(record.timestamp)
  return Number.isFinite(value) ? value : undefined
}

function optionalTs(ts: number | undefined): { ts?: number } {
  return ts === undefined ? {} : { ts }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function quantile(sorted: number[], q: number): number {
  // Та же интерполяция, что в ядре, но написанная заново: общий код сделал бы
  // сверку тавтологией.
  if (sorted.length === 0) return Number.NaN
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)
}

interface RawRow {
  provider: string
  model: string
  n: number
  unmeasured: number
  p50: number
  p90: number
  outputP50: number
  pace: number
  sumPace: number
}

function rawTable(requests: RawRequest[]): RawRow[] {
  const groups = new Map<string, RawRequest[]>()
  for (const request of requests) {
    const key = `${request.provider} ${request.model}`
    groups.set(key, [...(groups.get(key) ?? []), request])
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const measured = list.filter((r) => r.durationMs !== undefined)
      const durations = measured.map((r) => r.durationMs!).sort((a, b) => a - b)
      const outputs = measured.map((r) => r.output).sort((a, b) => a - b)
      const paces = measured.map((r) => (r.output * 1000) / r.durationMs!).sort((a, b) => a - b)
      const sumOut = measured.reduce((sum, r) => sum + r.output, 0)
      const sumMs = measured.reduce((sum, r) => sum + r.durationMs!, 0)
      const [provider, model] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)]
      return {
        provider,
        model,
        n: measured.length,
        unmeasured: list.length - measured.length,
        p50: quantile(durations, 0.5),
        p90: quantile(durations, 0.9),
        outputP50: quantile(outputs, 0.5),
        pace: quantile(paces, 0.5),
        sumPace: sumMs === 0 ? Number.NaN : (sumOut * 1000) / sumMs,
      }
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || b.n - a.n)
}

function printRaw(rows: RawRow[]): void {
  console.log(
    '  модель                          n      неизм.  p50      p90      out p50  тк/с   Σout/Σt',
  )
  for (const row of rows) {
    console.log(
      `  ${`${row.model} [${row.provider}]`.padEnd(32)}${String(row.n).padEnd(7)}${String(row.unmeasured).padEnd(8)}` +
        `${seconds(row.p50).padEnd(9)}${seconds(row.p90).padEnd(9)}${fixed(row.outputP50, 0).padEnd(9)}` +
        `${fixed(row.pace, 1).padEnd(7)}${fixed(row.sumPace, 1)}`,
    )
  }
}

function seconds(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} с` : '—'
}

function tokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function top(map: Map<string, number>, limit = 8): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => `${key} ${count}`)
    .join(', ')
}

// ─── прогон ──────────────────────────────────────────────────────────────────

const files: SourceFile[] = discoverSources({})
const raw: RawRequest[] = []
for (const file of files) {
  if (file.provider === 'claude') {
    raw.push(...rawClaude(file.path))
    if (RAW_ONLY) claudeInterleaving(file.path)
  } else {
    raw.push(...rawCodex(file.path))
  }
}
const rawRows = rawTable(raw)

let failed = false

if (RAW_ONLY) {
  console.log(`сырые логи: файлов ${files.length}, запросов ${raw.length}`)
  printRaw(rawRows)
  for (const provider of ['claude', 'codex'] as const) {
    const own = raw.filter((r) => r.provider === provider)
    const reasons = new Map<string, number>()
    for (const r of own) if (r.reason) bump(reasons, r.reason)
    console.log(
      `  ${provider}: неизмеримых ${own.length - own.filter((r) => r.durationMs !== undefined).length} из ${own.length}` +
        (reasons.size > 0 ? ` — ${top(reasons)}` : ''),
    )
  }

  console.log('\nзамер 1 — Claude, записи внутри запроса:')
  console.log(
    `  запросов ${claudeStats.requests}, из нескольких строк ${claudeStats.multiLine}, ` +
      `с чужой записью между первой и последней строкой ${claudeStats.interleaved}; ` +
      `старт «перед последней строкой» дал бы другое число у ${claudeStats.lastLineWouldDiffer}`,
  )
  console.log(`  что ложится между строками: ${top(claudeStats.interleavedTypes)}`)
  console.log(`  запись-старт по типу: ${top(claudeStats.startTypes)}`)
  console.log(`  разный output_tokens на строках одного запроса: ${claudeStats.outputVaries}`)

  console.log('\nзамер 2 — Codex, граница перед ответом:')
  console.log(
    `  запросов ${codexStats.requests} (повторов token_count отброшено ${codexStats.duplicates}), ` +
      `без границы после прошлого запроса ${codexStats.noBoundary}` +
      (codexStats.noBoundaryContext.size > 0
        ? ` — перед ними: ${top(codexStats.noBoundaryContext)}`
        : '') +
      `; без элемента ответа ${codexStats.noAnswer}`,
  )
  const gaps = [...codexStats.lateGapsMs].sort((a, b) => a - b)
  console.log(
    `  token_count позже последнего элемента ответа на ≥ 0.5 с: ${codexStats.lateTokenCount} из ${codexStats.requests}` +
      (gaps.length > 0
        ? `, медиана разрыва ${seconds(quantile(gaps, 0.5))}, максимум ${seconds(gaps.at(-1)!)}`
        : ''),
  )
  console.log(`  границы: ${top(codexStats.boundaryTypes, 12)}`)
  console.log(`  элементы ответа: ${top(codexStats.answerTypes, 12)}`)
  if (codexStats.otherItemTypes.size > 0)
    console.log(`  прочие response_item: ${top(codexStats.otherItemTypes, 12)}`)
} else {
  const temp = mkdtempSync(join(tmpdir(), 'agentmeter-speed-live-'))
  const { db } = openDb(join(temp, 'index.sqlite'))
  try {
    ingestAll(db)
    const allTime = { from: 0, to: Date.parse('2100-01-01T00:00:00.000Z') }
    const indexed = modelSpeeds(db, allTime)
    const measuredInIndex = db.get<{ n: number; total: number; reconstructed: number }>(
      `SELECT count(duration_ms) AS n, count(*) AS total,
              count(CASE WHEN origin != 'log' AND duration_ms IS NOT NULL THEN 1 END) AS reconstructed
       FROM requests`,
    )!
    console.log(
      `индекс: запросов ${measuredInIndex.total}, со временем ${measuredInIndex.n}, ` +
        `восстановленных со временем ${measuredInIndex.reconstructed}`,
    )
    report(
      1,
      'у восстановленных времени нет',
      `${measuredInIndex.reconstructed}`,
      measuredInIndex.reconstructed === 0,
    )

    console.log('\nиз индекса (modelSpeeds, весь период):')
    console.log('  модель                          n      p50      p90      тк/с')
    for (const [key, speed] of [...indexed.entries()].sort(
      (a, b) => b[1].requests - a[1].requests,
    )) {
      console.log(
        `  ${key.padEnd(32)}${String(speed.requests).padEnd(7)}${seconds(speed.p50Ms).padEnd(9)}` +
          `${seconds(speed.p90Ms).padEnd(9)}${fixed(speed.tokensPerSecond, 1)}`,
      )
    }
    console.log('\nиз сырых логов:')
    printRaw(rawRows)

    // Сверка: n до запроса, p50 до 0.1 с — у каждой модели выше порога.
    const broken: string[] = []
    let compared = 0
    for (const row of rawRows) {
      const key = `${row.provider} ${row.model}`
      const speed: ModelSpeed | undefined = indexed.get(key)
      if (row.n < SPEED.minRequests) {
        if (speed !== undefined) broken.push(`${key}: ниже порога (${row.n}), а скорость есть`)
        continue
      }
      compared += 1
      if (speed === undefined) {
        broken.push(`${key}: в индексе скорости нет, сырых ${row.n}`)
        continue
      }
      if (speed.requests !== row.n) broken.push(`${key}: n ${speed.requests} против ${row.n}`)
      if (Math.abs(speed.p50Ms - row.p50) >= 100)
        broken.push(`${key}: p50 ${seconds(speed.p50Ms)} против ${seconds(row.p50)}`)
    }
    for (const key of indexed.keys())
      if (!rawRows.some((row) => `${row.provider} ${row.model}` === key))
        broken.push(`${key}: есть в индексе, нет в сырых логах`)
    report(
      2,
      'индекс сходится с сырыми логами',
      `моделей сверено ${compared}, расхождений ${broken.length}` +
        (broken.length > 0 ? `\n      ${broken.slice(0, 10).join('\n      ')}` : ''),
      broken.length === 0 && compared > 0,
    )

    // Маргиналь матрицы — то, что видит экран: те же числа той же функцией.
    // Сегодняшний день печатается для сверки с окном на живом индексе,
    // весь период — источник чисел раздела 12 макета.
    const today = dayRange(Date.now(), 0)
    for (const [title, range] of [
      ['весь период', allTime],
      ['сегодня (сверка с экраном)', today],
    ] as const) {
      const matrix = spendMatrix(db, range)
      console.log(
        `\nматрица, ${title}: ${tokens(matrix.totals.total)}, моделей ${matrix.models.length}`,
      )
      for (const cell of matrix.models) {
        const pivot = matrix.rows
          .flatMap((row) =>
            row.cells
              .filter((own) => own.provider === cell.provider && own.model === cell.model)
              .map((own) => ({
                project: row.project || '—',
                share: own.totals.total / cell.totals.total,
              })),
          )
          .sort((a, b) => b.share - a.share)
          .slice(0, 5)
          .map((part) => `${part.project} ${Math.round(part.share * 100)}%`)
          .join(' · ')
        const speed = cell.speed
        console.log(
          `  ${`${cell.model} [${cell.provider}]`.padEnd(32)}${tokens(cell.totals.total).padEnd(9)}` +
            `${((cell.totals.total / Math.max(1, matrix.totals.total)) * 100).toFixed(1).padStart(5)}%  ` +
            (speed
              ? `ответ ${seconds(speed.p50Ms)} · p90 ${seconds(speed.p90Ms)} · ${fixed(speed.tokensPerSecond, 1)} тк/с · n ${speed.requests}`
              : 'мало данных') +
            `\n      ${pivot}`,
        )
      }
      const mismatch = matrix.models.filter((cell) => {
        const own = modelSpeeds(db, range).get(`${cell.provider} ${cell.model}`)
        return JSON.stringify(own) !== JSON.stringify(cell.speed)
      })
      report(
        3,
        `маргиналь матрицы — та же функция (${title})`,
        `расхождений ${mismatch.length}`,
        mismatch.length === 0,
      )
    }
  } finally {
    db.close()
    rmSync(temp, { recursive: true, force: true })
  }
}

function report(n: number, name: string, detail: string, ok: boolean): void {
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${n}. ${name}: ${detail}`)
}

if (failed) process.exitCode = 1
