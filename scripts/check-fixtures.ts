/**
 * Проверка фикстур: на месте ли, парсятся ли, обезличены ли и — главное —
 * содержит ли каждая тот сценарий, ради которого её брали.
 *
 *     node --experimental-strip-types scripts/check-fixtures.ts
 *
 * Последнее важнее всего: фикстура `parallel` без единого параллельного
 * вызова зелёная по всем формальным признакам и бесполезна по существу.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLAUDE = join(ROOT, 'fixtures/claude')
const CODEX = join(ROOT, 'fixtures/codex')

/** Следы живых данных, которых в репозитории быть не должно. */
const LEAKS = [/fost/i, /Users\//, /pilot/i, /garmhub/i, /flutter/i, /[A-Z]{3,}-\d{2,}/]

const failures: string[] = []
const notes: string[] = []

function check(name: string, ok: boolean, detail: string): void {
  if (ok) notes.push(`  ✓ ${name} — ${detail}`)
  else failures.push(`  ✗ ${name} — ${detail}`)
}

function readJsonl(path: string): Record<string, any>[] {
  const out: Record<string, any>[] = []
  const text = readFileSync(path, 'utf8')
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    try {
      out.push(JSON.parse(line))
    } catch {
      failures.push(`  ✗ ${path}:${i + 1} — строка не разбирается как JSON`)
    }
  })
  return out
}

function assistants(rows: Record<string, any>[]): Record<string, any>[] {
  return rows.filter((r) => r['type'] === 'assistant')
}

/** Запросы, схлопнутые по requestId: usage последней строки полнее первой. */
function requests(rows: Record<string, any>[]): { cr: number; cw: number; out: number }[] {
  const acc = new Map<string, { cr: number; cw: number; out: number }>()
  const order: string[] = []
  for (const r of assistants(rows)) {
    const rid = r['requestId'] as string
    const u = r['message']?.usage ?? {}
    const v = {
      cr: u.cache_read_input_tokens ?? 0,
      cw: u.cache_creation_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
    }
    const prev = acc.get(rid)
    if (prev) {
      prev.cr = Math.max(prev.cr, v.cr)
      prev.cw = Math.max(prev.cw, v.cw)
      prev.out = Math.max(prev.out, v.out)
    } else {
      acc.set(rid, v)
      order.push(rid)
    }
  }
  return order.map((rid) => acc.get(rid)!)
}

function toolUsesByRequest(rows: Record<string, any>[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const r of assistants(rows)) {
    const rid = r['requestId'] as string
    for (const c of r['message']?.content ?? []) {
      if (c?.type === 'tool_use') map.set(rid, [...(map.get(rid) ?? []), c.name])
    }
  }
  return map
}

// ─── формальные требования ко всем фикстурам ─────────────────────────────────

const SCENARIOS = [
  'plain',
  'sidechain',
  'mcp',
  'parallel',
  'images',
  'compact',
  'version-old',
  'version-mid',
]

const parsed = new Map<string, Record<string, any>[]>()

for (const name of SCENARIOS) {
  const jsonl = join(CLAUDE, `${name}.jsonl`)
  const expected = join(CLAUDE, `${name}.expected.json`)
  if (!existsSync(jsonl)) {
    failures.push(`  ✗ ${name} — нет ${name}.jsonl`)
    continue
  }
  if (!existsSync(expected)) failures.push(`  ✗ ${name} — нет ${name}.expected.json`)
  const rows = readJsonl(jsonl)
  parsed.set(name, rows)
  check(name, rows.length > 0, `${rows.length} записей, ${assistants(rows).length} строк assistant`)

  const text = readFileSync(jsonl, 'utf8')
  const leak = LEAKS.find((re) => re.test(text))
  if (leak) failures.push(`  ✗ ${name} — обезличивание не прошло, найдено ${leak}`)
}

// ─── содержательные требования: каждая фикстура про своё ─────────────────────

const plain = parsed.get('plain') ?? []
const plainRids = assistants(plain).map((r) => r['requestId'] as string)
check(
  'plain / дубли requestId',
  plainRids.length > new Set(plainRids).size,
  `${plainRids.length} строк на ${new Set(plainRids).size} запросов`,
)
{
  const rs = requests(plain)
  const warms = rs.filter((r, i) => i > 0 && r.cr - (rs[i - 1]!.cr + rs[i - 1]!.cw) > 0).length
  check('plain / незаписанные запросы', warms > 0, `${warms} разрывов цепочки кэша`)
}
check(
  'plain / название задачи',
  plain.some((r) => r['type'] === 'ai-title'),
  'есть запись ai-title',
)

{
  const dir = join(CLAUDE, 'sidechain.subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  check('sidechain / транскрипты сабагентов', files.length > 0, `${files.length} файлов`)
  for (const f of files) {
    const rows = readJsonl(join(dir, f))
    check(
      `sidechain / ${f}`,
      rows.every((r) => r['isSidechain'] !== false) && rows.some((r) => r['isSidechain'] === true),
      'isSidechain выставлен',
    )
  }
  const meta = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.meta.json')) : []
  check('sidechain / meta', meta.length > 0, `${meta.length} файлов meta с agentType и toolUseId`)
  check(
    'sidechain / вызов Agent в родителе',
    [...toolUsesByRequest(parsed.get('sidechain') ?? []).values()]
      .flat()
      .some((n) => n === 'Agent' || n === 'Task'),
    'родитель вызывает сабагента',
  )
}

{
  const names = [...toolUsesByRequest(parsed.get('mcp') ?? []).values()].flat()
  const mcp = names.filter((n) => n.startsWith('mcp__'))
  const servers = new Set(mcp.map((n) => n.split('__')[1]))
  check('mcp / вызовы MCP', mcp.length > 0, `${mcp.length} вызовов, серверы: ${[...servers].join(', ')}`)
}

{
  const multi = [...toolUsesByRequest(parsed.get('parallel') ?? []).values()].filter(
    (v) => v.length > 1,
  )
  check(
    'parallel / несколько тулов на запрос',
    multi.length > 0,
    `${multi.length} запросов, максимум ${Math.max(0, ...multi.map((v) => v.length))} вызовов`,
  )
}

{
  const rows = parsed.get('images') ?? []
  let images = 0
  for (const r of rows) {
    const content = r['message']?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const inner = b?.content
      if (Array.isArray(inner) && inner.some((x: any) => x?.type === 'image')) images++
    }
  }
  check('images / картинка в результате тула', images > 0, `${images} результатов с image`)
}

{
  const rs = requests(parsed.get('compact') ?? [])
  const drops = rs.filter((r, i) => i > 0 && r.cr < rs[i - 1]!.cr * 0.6 && rs[i - 1]!.cr > 20000)
  check('compact / обвал префикса', drops.length > 0, `${drops.length} обвалов — контекст сжали`)
}

{
  const versions = new Set<string>()
  for (const name of SCENARIOS) {
    for (const r of parsed.get(name) ?? []) if (r['version']) versions.add(r['version'] as string)
  }
  check(
    'versions / разные версии CLI',
    versions.size >= 3,
    `${versions.size} версий: ${[...versions].sort().join(', ')}`,
  )
}

{
  const path = join(CODEX, 'rollout.jsonl')
  if (!existsSync(path)) {
    failures.push('  ✗ codex — нет rollout.jsonl')
  } else {
    const rows = readJsonl(path)
    const text = readFileSync(path, 'utf8')
    check('codex / записи', rows.length > 0, `${rows.length} записей`)
    check('codex / token_count', text.includes('total_token_usage'), 'есть total_token_usage')
    check('codex / rate_limits', text.includes('rate_limits'), 'есть rate_limits')

    const leak = LEAKS.find((re) => re.test(text))
    if (leak) failures.push(`  ✗ codex — обезличивание не прошло, найдено ${leak}`)

    // Формат Codex несёт собственную проверку: сумма расхода по запросам
    // обязана сойтись с накопительным итогом. Не сойдётся — фикстура порезана
    // неудачно, и парсер будет отлаживаться по кривым данным.
    const expPath = join(CODEX, 'rollout.expected.json')
    if (!existsSync(expPath)) {
      failures.push('  ✗ codex — нет rollout.expected.json')
    } else {
      const exp = JSON.parse(readFileSync(expPath, 'utf8'))
      const t = exp.totals
      const total = exp.totalTokenUsage
      check(
        'codex / суммы сходятся с total_token_usage',
        t.output === total.output_tokens &&
          t.input + t.cacheRead === total.input_tokens &&
          t.reasoning === total.reasoning_output_tokens,
        `${exp.requests.length} запросов, ${exp.limits.length} окон лимитов`,
      )

      // Один вызов тула лежит в логе двумя записями: response_item/function_call
      // и — если это MCP — event_msg/mcp_tool_call_end с тем же call_id. Считать
      // их за два вызова значит удвоить MCP. Уникальность call_id это ловит.
      const tools = exp.requests.flatMap((r: Record<string, any>) => r.tools ?? [])
      const ids = new Set(tools.map((t: Record<string, any>) => t.id))
      const mcp = tools.filter((t: Record<string, any>) => t.kind === 'mcp')
      check(
        'codex / вызовы тулов не задвоены',
        tools.length === ids.size,
        `${tools.length} вызовов на ${ids.size} call_id`,
      )
      check(
        'codex / MCP размечен сервером',
        mcp.length > 0 && mcp.every((t: Record<string, any>) => typeof t.server === 'string'),
        `${mcp.length} вызовов MCP`,
      )
    }
  }
}

// ─── итог ────────────────────────────────────────────────────────────────────

for (const n of notes) console.log(n)
if (failures.length) {
  console.error('\nне сошлось:')
  for (const f of failures) console.error(f)
  console.error(`\n${failures.length} проблем`)
  process.exit(1)
}
console.log(`\nвсе фикстуры на месте и содержат свои сценарии (${notes.length} проверок)`)
