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
const PREFIX = join(ROOT, 'fixtures/prefix')
const LIMITS = join(ROOT, 'fixtures/limits')
const USAGE = join(ROOT, 'fixtures/usage')
const OAUTH = join(ROOT, 'fixtures/oauth')

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
  check(
    'mcp / вызовы MCP',
    mcp.length > 0,
    `${mcp.length} вызовов, серверы: ${[...servers].join(', ')}`,
  )
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
        `${exp.requests.length} запросов, ${exp.limits.length} наблюдений лимита`,
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

// ─── стартовый префикс: синтетические логи рядом с ручным ответом ───────────

for (const name of ['claude-prefix', 'claude-eager', 'codex-prefix']) {
  const jsonl = join(PREFIX, `${name}.jsonl`)
  const expected = join(PREFIX, `${name}.expected.json`)
  if (!existsSync(jsonl)) {
    failures.push(`  ✗ prefix / ${name} — нет ${name}.jsonl`)
    continue
  }
  if (!existsSync(expected)) failures.push(`  ✗ prefix / ${name} — нет ручного expected.json`)
  const rows = readJsonl(jsonl)
  check(`prefix / ${name}`, rows.length > 0, `${rows.length} записей`)
  const text = readFileSync(jsonl, 'utf8')
  const leak = LEAKS.find((re) => re.test(text))
  if (leak) failures.push(`  ✗ prefix / ${name} — обезличивание не прошло, найдено ${leak}`)
}

// ─── окна лимита: сценарий важнее формы ─────────────────────────────────────

{
  const slots = (rows: Record<string, any>[]): Record<string, any>[] =>
    rows.flatMap((r) => {
      const rl = r.payload?.rate_limits
      return rl ? [rl.primary, rl.secondary].filter(Boolean) : []
    })

  for (const name of [
    'codex-limits',
    'codex-limits-new',
    'codex-limits-odd',
    'codex-limits-gone',
    'claude-limits',
  ]) {
    const jsonl = join(LIMITS, `${name}.jsonl`)
    if (!existsSync(jsonl)) {
      failures.push(`  ✗ limits / ${name} — нет ${name}.jsonl`)
      continue
    }
    if (!existsSync(join(LIMITS, `${name}.expected.json`))) {
      failures.push(`  ✗ limits / ${name} — нет ручного expected.json`)
    }
    const text = readFileSync(jsonl, 'utf8')
    const leak = LEAKS.find((re) => re.test(text))
    if (leak) failures.push(`  ✗ limits / ${name} — обезличивание не прошло, найдено ${leak}`)
  }

  const old = slots(readJsonl(join(LIMITS, 'codex-limits.jsonl')))
  const five = old.filter((s) => s.window_minutes === 300)
  check(
    'limits / старая раскладка слотов',
    five.length > 0 && old.some((s) => s.window_minutes === 10080),
    `${five.length} наблюдений 300 мин и ${old.length - five.length} недельных`,
  )
  // Ради этого наблюдения фикстура и существует: взять последнее вместо
  // максимума значит показать 3% там, где израсходовано 12%.
  const stale = five.findIndex((s, i) => i > 0 && s.used_percent < five[i - 1].used_percent)
  check(
    'limits / есть протухшее наблюдение',
    stale > 0,
    `падение ${five[stale - 1]?.used_percent}% → ${five[stale]?.used_percent}% внутри окна`,
  )
  check(
    'limits / окно истекает и открывается заново',
    new Set(five.map((s) => s.resets_at)).size >= 2,
    `${new Set(five.map((s) => s.resets_at)).size} разных resets_at на 300 мин`,
  )

  const fresh = readJsonl(join(LIMITS, 'codex-limits-new.jsonl'))
  const freshSlots = fresh.flatMap((r) => (r.payload?.rate_limits ? [r.payload.rate_limits] : []))
  check(
    'limits / раскладка после 0.145.0',
    freshSlots.length > 0 &&
      freshSlots.every((rl) => rl.primary?.window_minutes === 10080 && rl.secondary === null),
    `${freshSlots.length} записей, primary = недельное, secondary = null`,
  )

  const odd = slots(readJsonl(join(LIMITS, 'codex-limits-odd.jsonl'))).map((s) => s.window_minutes)
  check(
    'limits / месячное и незнакомое окно',
    odd.includes(43200) && odd.some((m) => ![300, 10080, 43200].includes(m)),
    `длины окон: ${odd.join(', ')}`,
  )

  // Окно, о котором провайдер перестал говорить (6.4). Проверяется не разбор —
  // его проверяет тест, — а то, что в фикстуре остались три случая, ради
  // которых она написана: длина пропала, длина вернулась, и запись, не
  // назвавшая ни одного окна. Убери любой — и правило снова станет зелёным на
  // данных, которые его не проверяют.
  {
    const rows = readJsonl(join(LIMITS, 'codex-limits-gone.jsonl')).filter(
      (r) => r.payload?.rate_limits,
    )
    const named = rows.map((r) =>
      [r.payload.rate_limits.primary, r.payload.rate_limits.secondary]
        .filter(Boolean)
        .map((s: { window_minutes: number }) => s.window_minutes),
    )
    const has = (length: number): boolean[] => named.map((set) => set.includes(length))
    const weekly = has(10080)
    check(
      'limits / длина пропадает и возвращается новым окном',
      weekly.indexOf(true) < weekly.indexOf(false) && weekly.lastIndexOf(true) > weekly.indexOf(false),
      `недельное названо в записях [${weekly.map((v, i) => (v ? i + 1 : '')).filter(Boolean).join(', ')}] из ${weekly.length}`,
    )
    check(
      'limits / есть запись без единого окна',
      named.some((set) => set.length === 0),
      'такая запись — «данных пока нет», и закрывать ею нельзя ничего',
    )
    check(
      'limits / пропавшая длина не одна',
      named.some((set) => set.includes(43200)) && named.some((set) => set.includes(300)),
      'месячное и пятичасовое проверяют разные ветки правила',
    )
  }

  const turns = readJsonl(join(LIMITS, 'claude-limits.jsonl')).filter((r) => r.type === 'assistant')
  const stamps = turns.map((r) => Date.parse(r.timestamp))
  {
    // Восстановленные запросы (1.3) обязаны быть: без них правило «в окно
    // входят все вызовы API, а не только записанные» ничем не проверяется, и
    // фильтр по origin прошёл бы незамеченным.
    const rs = requests(readJsonl(join(LIMITS, 'claude-limits.jsonl')))
    const warms = rs.filter((r, i) => i > 0 && r.cr - (rs[i - 1]!.cr + rs[i - 1]!.cw) > 0).length
    check(
      'limits / незаписанные запросы внутри окна',
      warms === 3,
      `${warms} разрывов цепочки кэша`,
    )
  }
  const border = stamps[0] + 5 * 60 * 60 * 1000
  check(
    'limits / граница пятичасового окна проверяется минутой',
    stamps.some((t) => border - t > 0 && border - t <= 60_000) && stamps.some((t) => t > border),
    `${turns.length} запросов, последний внутри окна за ${(border - Math.max(...stamps.filter((t) => t < border))) / 1000} с до сброса`,
  )
}

// ─── журнал строки состояния (1.9) ───────────────────────────────────────────
//
// Фикстура обратная: проценты посчитаны из зашитого ответа. Проверяется здесь
// не форма, а то, ради чего она взята, — что хотя бы одно окно **обязано** быть
// отброшено и что проценты действительно сходятся с объявленной правдой.
// Журнал, «почти» сходящийся с ней, зелен по форме и бесполезен по существу.
{
  const journal = readJsonl(join(USAGE, 'journal.jsonl'))
  const expected = JSON.parse(readFileSync(join(USAGE, 'expected.json'), 'utf8'))
  const requests = JSON.parse(readFileSync(join(USAGE, 'requests.json'), 'utf8')).requests
  const { cacheReadWeight: w, fiveHourCap, weeklyCap } = expected.truth

  check(
    'usage / журнал и запросы на месте',
    journal.length === 6 && requests.length === 5,
    `${journal.length} снимков, ${requests.length} запросов`,
  )

  // Каждый снимок пятичасового окна: сумма наших запросов внутри окна до его
  // момента, взвешенная зашитым весом, обязана дать ровно записанный процент.
  const off: string[] = []
  let foreign = 0
  for (const row of journal) {
    for (const [key, cap, minutes] of [
      ['fiveHour', fiveHourCap, 300],
      ['weekly', weeklyCap, 10080],
    ] as const) {
      const sample = row[key]
      if (!sample) continue
      const from = sample.resetsAt - minutes * 60_000
      const inside = requests.filter((r: any) => r.ts >= from && r.ts <= row.ts)
      const plain = inside.reduce((s: number, r: any) => s + r.input + r.output + r.cacheWrite, 0)
      const read = inside.reduce((s: number, r: any) => s + r.cacheRead, 0)
      const pct = ((plain + w * read) * 100) / cap
      if (Math.abs(pct - sample.pct) < 1e-9) continue
      if (sample.pct > pct) foreign += 1
      else off.push(`${key}@${row.ts}: ${sample.pct} против ${pct.toFixed(4)}`)
    }
  }
  check(
    'usage / проценты сходятся с зашитым ответом',
    off.length === 0,
    off.length === 0 ? `w=${w}, потолки ${fiveHourCap}/${weeklyCap}` : off.join('; '),
  )

  // Тот самый снимок, который обязан быть отброшен: процент выше, чем оправдывает
  // наша сумма. Без него фикстура не проверяет отсев вовсе.
  check(
    'usage / есть чужой расход, который обязан быть отброшен',
    foreign > 0 && expected.dropped.length === 2,
    `снимков с чужим расходом ${foreign}, окон в ожидании ${expected.dropped.length}`,
  )
}

// ─── oauth: ответ провайдера и целочисленный журнал (6.3) ────────────────────
//
// Живой ответ здесь проверяется на то, ради чего он и снят: что проценты в нём
// **целые**. Придёт день, когда источник начнёт отдавать дробные, — и порог
// `minIntegerPct` из необходимости станет вредом. Пусть об этом скажет
// проверка, а не расхождение потолков через месяц.
{
  const live = JSON.parse(readFileSync(join(OAUTH, 'usage-live.json'), 'utf8'))
  const entries: Array<{ kind?: string; percent?: number }> = live.limits ?? []
  const named = ['session', 'weekly_all'].map((kind) => entries.find((e) => e.kind === kind))
  check(
    'oauth / в живом ответе есть оба окна',
    named.every((entry) => entry !== undefined),
    named.map((entry) => `${entry?.kind}=${entry?.percent}%`).join(', '),
  )
  check(
    'oauth / проценты целые — на этом стоит minIntegerPct',
    named.every((entry) => Number.isInteger(entry?.percent)),
    `${named.map((entry) => entry?.percent).join(' / ')}`,
  )
  check(
    'oauth / в ответе есть окно без границы, которое обязано пропускаться',
    entries.some((entry) => (entry as { resets_at?: unknown }).resets_at === null),
    'weekly_scoped без resets_at',
  )

  const models = JSON.parse(readFileSync(join(OAUTH, 'usage-models.json'), 'utf8'))
  check(
    'oauth / есть фикстура с модельными окнами',
    models.seven_day_opus !== null && models.limits.some((e: { kind: string }) => e.kind === 'weekly_scoped'),
    'seven_day_opus и активный weekly_scoped на месте',
  )

  const creds = readFileSync(join(OAUTH, 'credentials-keychain.json'), 'utf8')
  check(
    'oauth / токены в фикстуре — заглушки',
    creds.includes('FIXTURE-NOT-A-REAL-TOKEN'),
    'настоящих токенов в репозитории нет',
  )

  // Целочисленный журнал: те же обратные проценты, что в основном эталоне, и
  // ровно одна точка, которая обязана отсеяться порогом.
  const journal = readJsonl(join(USAGE, 'journal-oauth.jsonl'))
  const requests = JSON.parse(readFileSync(join(USAGE, 'requests-oauth.json'), 'utf8')).requests
  const expectedOauth = JSON.parse(readFileSync(join(USAGE, 'expected-oauth.json'), 'utf8'))
  const { cacheReadWeight: w, fiveHourCap } = expectedOauth.truth
  const below: number[] = []
  const off: string[] = []
  for (const row of journal) {
    const sample = row['fiveHour']
    if (!sample) continue
    const from = sample.resetsAt - 300 * 60_000
    const inside = requests.filter((r: any) => r.ts >= from && r.ts <= row.ts)
    const plain = inside.reduce((s: number, r: any) => s + r.input + r.output + r.cacheWrite, 0)
    const read = inside.reduce((s: number, r: any) => s + r.cacheRead, 0)
    const pct = ((plain + w * read) * 100) / fiveHourCap
    if (sample.pct < 10) below.push(sample.pct)
    else if (Math.abs(pct - sample.pct) > 1e-9) off.push(`${sample.pct} против ${pct.toFixed(4)}`)
  }
  check(
    'oauth / точки выше порога сходятся с зашитым ответом',
    off.length === 0 && journal.every((row: any) => row.source === 'oauth'),
    off.length === 0 ? `w=${w}, потолок ${fiveHourCap}` : off.join('; '),
  )
  check(
    'oauth / есть точка ниже порога — ради неё фикстура и написана',
    below.length === 1,
    `точек ниже ${10}%: ${below.join(', ')}`,
  )

  codexOauth()
}

/**
 * Эталон второго источника Codex (6.4).
 *
 * Проверяется не разбор — его проверяет тест, — а то, что в эталоне остались
 * случаи, ради которых он написан. Ловушка тут одна и она тихая: подправь
 * кто-нибудь `slots-swapped` так, чтобы недельное окно вернулось в `secondary`,
 * — и разбор по имени слота снова пройдёт зелёным, а на живом Codex соврёт.
 */
function codexOauth(): void {
  const fixture = JSON.parse(readFileSync(join(USAGE, 'codex-oauth.json'), 'utf8'))
  const cases = new Map<string, any>(fixture.cases.map((entry: any) => [entry.name, entry]))

  const swapped = cases.get('slots-swapped')
  check(
    'codex-oauth / имя слота противоречит длине окна',
    swapped?.response.rate_limit.primary_window.limit_window_seconds === 604_800 &&
      swapped?.response.rate_limit.secondary_window.limit_window_seconds === 18_000,
    'недельное окно лежит в primary, пятичасовое в secondary',
  );

  {
    const live = cases.get('live')
    const window = live?.response.rate_limit.primary_window
    check(
      'codex-oauth / живой ответ снят с недельным окном в primary',
      window?.limit_window_seconds === 604_800 && live?.response.rate_limit.secondary_window === null,
      'так отвечает Codex CLI 0.145.0 и новее',
    )
    check(
      'codex-oauth / при нулевом проценте граница — заглушка провайдера',
      window?.used_percent === 0 && window.reset_at * 1000 - fixture.ts === window.limit_window_seconds * 1000,
      'reset_at равен ts + длина окна до секунды',
    )
  }

  check(
    'codex-oauth / есть окно без длины и оно обязано выпасть',
    cases.get('length-missing')?.windows.length === 1,
    'из двух окон в разбор идёт одно',
  )
  check(
    'codex-oauth / есть дробный процент',
    cases.get('reset-after')?.windows[0].usedPercent === 33.5,
    'округление до целого поймается',
  )
  check(
    'codex-oauth / соседние пулы лежат в ответе, но не в окнах',
    cases.get('other-pools')?.response.code_review_rate_limit !== null &&
      cases.get('other-pools')?.windows.length === 1,
    'code_review_rate_limit и additional_rate_limits на месте',
  )

  const tokens = fixture.credentials.map((entry: any) => JSON.stringify(entry.raw ?? ''))
  check(
    'codex-oauth / токены в эталоне — заглушки',
    tokens.every((raw: string) => !raw.includes('eyJhbGciOi')),
    'настоящих токенов в репозитории нет',
  )
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
