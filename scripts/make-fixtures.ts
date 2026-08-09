/**
 * Сборка фикстур из живых логов: обрезка, обезличивание, ожидаемый разбор.
 *
 * Не одноразовый скрипт: формат логов дрейфует с версиями CLI, фикстуры
 * придётся пересобирать. Источники и что каждая фикстура проверяет — в
 * `fixtures.config.json`.
 *
 *     node --experimental-strip-types scripts/make-fixtures.ts
 *
 * Обезличивание идёт по одному правилу: всё, что не в списке структурных
 * ключей, — текст, и он заменяется заглушкой ТОЙ ЖЕ длины. Длина важна:
 * на ней стоит дележ дельты между параллельными вызовами, и фикстура с
 * укороченными текстами тихо сломает атрибуцию (1.6).
 *
 * Не трогаем вообще: usage, requestId, timestamp, имена тулов и серверов,
 * версии, флаги. Это и есть предмет разбора.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'fixtures')

/** Значения этих ключей — структура, а не данные. Сохраняются как есть. */
const STRUCTURAL = new Set([
  'type',
  'subtype',
  'role',
  'model',
  'name', // имя тула, включая mcp__<server>__<tool>
  'stop_reason',
  'stop_sequence',
  'service_tier',
  'requestId',
  'timestamp',
  'version',
  'userType',
  'entrypoint',
  'kind',
  'mode',
  'permissionMode',
  'effort',
  'agentType',
  'status',
  'inference_geo',
  'speed',
  'level',
  'source',
  'tier',
  'id', // toolu_*, msg_*
  'tool_use_id',
  'toolUseId',
  'media_type',
  'cache_control',
  'ttl',
  // Codex: то же самое, другими словами
  'originator',
  'cli_version',
  'model_provider',
  'plan_type',
  'limit_id',
  'limit_name',
  'rate_limit_reached_type',
  'collaboration_mode_kind',
  'approval_policy',
  'sandbox_policy',
  'network',
  'access',
  'reasoning_effort',
  'personality',
  'phase',
  'current_date',
  'timezone',
  'server', // имя MCP-сервера в invocation — предмет разбора
  'tool',
])

/** Идентификаторы API: не приватны и удобны при отладке, оставляем как есть. */
const ID_PREFIXES = ['toolu_', 'msg_', 'req_', 'call_', 'fc_', 'rs_']

/** Идентификаторы: заменяются на детерминированные, но связность сохраняется. */
const IDENTIFIERS = new Set([
  'sessionId',
  'uuid',
  'parentUuid',
  'sourceToolAssistantUUID',
  'leafUuid',
  'interruptedMessageId',
  'promptId',
  'agentId',
  'id',
  'turn_id',
  'session_id',
])

/** Пути и ветки: заменяются на синтетические, структура пути сохраняется. */
const PATHY = new Set(['cwd', 'gitBranch', 'slug', 'path', 'subpath', 'file_path', 'filePath'])

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat '

/** Заглушка ровно той же длины, что и оригинал. Переводы строк сохраняются. */
function stub(text: string): string {
  if (text.length === 0) return ''
  const out: string[] = []
  let i = 0
  for (const ch of text) {
    if (ch === '\n' || ch === '\t') {
      out.push(ch)
    } else {
      out.push(LOREM[i % LOREM.length]!)
      i++
    }
  }
  return out.join('')
}

/** uuid того же вида, что и настоящий, но выведенный из хэша исходного. */
function fakeUuid(value: string): string {
  const h = createHash('sha256').update(value).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const projectAlias = new Map<string, string>()
function aliasFor(realPath: string): string {
  const key = realPath.replace(homedir(), '~')
  let alias = projectAlias.get(key)
  if (!alias) {
    alias = `/proj/${String.fromCharCode(97 + projectAlias.size)}`
    projectAlias.set(key, alias)
  }
  return alias
}

function anonymizePath(value: string): string {
  // /Users/fost/Projects/pilot/src/app.ts → /proj/a/lorem/ipsum.ts
  if (!value.startsWith('/') && !value.startsWith('~')) return stub(value)
  const home = homedir()
  const normalized = value.startsWith(home) ? value.replace(home, '~') : value
  const parts = normalized.split('/')
  const head = parts.slice(0, 4).join('/')
  const alias = aliasFor(head)
  const tail = parts.slice(4).map((p) => (p ? stub(p) : p))
  return tail.length ? `${alias}/${tail.join('/')}` : alias
}

function anonymize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => anonymize(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'usage' ? v : anonymize(v, k)
    }
    return out
  }
  if (typeof value !== 'string') return value
  if (key && STRUCTURAL.has(key)) return value
  if (ID_PREFIXES.some((p) => value.startsWith(p))) return value
  if (key && IDENTIFIERS.has(key)) return fakeUuid(value)
  if (key === 'gitBranch' || key === 'branch') return 'feature/one'
  if (key && PATHY.has(key)) return anonymizePath(value)
  return stub(value)
}

// ─── ожидаемый разбор ────────────────────────────────────────────────────────

interface ExpectedRequest {
  seq: number
  requestId: string
  ts: string
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  contextTokens: number
  isSidechain: boolean
  compacted: boolean
  synthetic: boolean
  origin: 'log' | 'reconstructed'
  tools: {
    id: string
    name: string
    kind: string
    server?: string
    resultBytes: number
    hasImage: boolean
  }[]
}

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function toolKind(name: string): { kind: string; server?: string } {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return { kind: 'mcp', server: parts[1] }
  }
  if (name === 'Agent' || name === 'Task') return { kind: 'agent' }
  if (name === 'Skill') return { kind: 'skill' }
  if (name === 'WebSearch' || name === 'WebFetch') return { kind: 'web' }
  return { kind: 'builtin' }
}

/**
 * Ожидаемый разбор строится здесь, а не парсером из `core` — иначе фикстура
 * подтверждала бы сама себя. Правила ровно те, что установлены разведкой:
 * схлопывание по requestId максимумом (стриминг наращивает output_tokens) и
 * восстановление незаписанных запросов по разрыву цепочки кэша.
 */
function buildExpected(lines: unknown[]): {
  session: Record<string, unknown>
  requests: ExpectedRequest[]
  totals: Record<string, number>
  unknownTypes: Record<string, number>
} {
  const byRequest = new Map<string, ExpectedRequest>()
  const order: string[] = []
  const unknownTypes: Record<string, number> = {}
  const known = new Set([
    'assistant',
    'user',
    'system',
    'ai-title',
    'last-prompt',
    'attachment',
    'file-history-snapshot',
    'file-history-delta',
    'mode',
    'permission-mode',
    'queue-operation',
    'summary',
  ])
  const session: Record<string, unknown> = {}

  // Результаты тулов лежат ниже вызова, поэтому собираем их отдельным проходом.
  // Размер берём по сериализованному toolUseResult — он же лежит в логе, — но
  // это НЕ то, что ушло в промпт: на реальном Read в логе 382 КБ против 2873
  // токенов в промпте. Правду даст только атрибуция (1.6).
  const results = new Map<string, { bytes: number; hasImage: boolean }>()
  for (const raw of lines) {
    const r = raw as Record<string, any>
    if (r['type'] !== 'user') continue
    const content = r['message']?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue
      const payload = r['toolUseResult'] ?? block.content
      const inner = block.content
      results.set(block.tool_use_id as string, {
        bytes: payload === undefined ? 0 : JSON.stringify(payload).length,
        hasImage: Array.isArray(inner) && inner.some((x: any) => x?.type === 'image'),
      })
    }
  }

  for (const raw of lines) {
    const r = raw as Record<string, any>
    const type = r['type'] as string
    if (!known.has(type)) unknownTypes[type] = (unknownTypes[type] ?? 0) + 1

    if (type === 'ai-title' && r['aiTitle']) session['title'] = r['aiTitle']
    if (type === 'last-prompt' && r['lastPrompt'] && !session['firstPrompt']) {
      session['firstPrompt'] = r['lastPrompt']
    }
    if (type !== 'assistant') continue

    const rid = r['requestId'] as string
    const u = (r['message']?.usage ?? {}) as Usage
    const tools = ((r['message']?.content ?? []) as any[])
      .filter((c) => c?.type === 'tool_use')
      .map((c) => {
        const res = results.get(c.id as string)
        return {
          id: c.id as string,
          name: c.name as string,
          ...toolKind(c.name as string),
          resultBytes: res?.bytes ?? 0,
          hasImage: res?.hasImage ?? false,
        }
      })

    session['id'] ??= r['sessionId']
    session['cwd'] ??= r['cwd']
    session['branch'] ??= r['gitBranch']
    session['model'] ??= r['message']?.model
    session['cliVersion'] ??= r['version']
    session['startedAt'] ??= r['timestamp']
    session['endedAt'] = r['timestamp']

    const prev = byRequest.get(rid)
    if (prev) {
      // стриминг: поздние строки того же запроса содержат более полный usage
      prev.output = Math.max(prev.output, u.output_tokens ?? 0)
      prev.input = Math.max(prev.input, u.input_tokens ?? 0)
      prev.cacheWrite = Math.max(prev.cacheWrite, u.cache_creation_input_tokens ?? 0)
      prev.cacheRead = Math.max(prev.cacheRead, u.cache_read_input_tokens ?? 0)
      prev.contextTokens = prev.input + prev.cacheRead + prev.cacheWrite
      prev.tools.push(...tools)
      continue
    }
    order.push(rid)
    byRequest.set(rid, {
      seq: 0,
      requestId: rid,
      ts: r['timestamp'],
      model: r['message']?.model,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      contextTokens:
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      isSidechain: Boolean(r['isSidechain']),
      compacted: false,
      synthetic: false,
      origin: 'log',
      tools,
    })
  }

  // разрыв цепочки кэша: между соседями прошёл запрос, которого в логе нет
  const requests: ExpectedRequest[] = []
  let last: ExpectedRequest | undefined
  for (const rid of order) {
    const r = byRequest.get(rid)!
    if (last) {
      const gap = r.cacheRead - (last.cacheRead + last.cacheWrite)
      if (gap > 0) {
        requests.push({
          seq: 0,
          requestId: `reconstructed:${last.requestId}`,
          ts: last.ts,
          model: last.model,
          input: 0,
          output: 0,
          cacheWrite: gap,
          cacheRead: last.cacheRead + last.cacheWrite,
          contextTokens: last.cacheRead + last.cacheWrite + gap,
          isSidechain: last.isSidechain,
          compacted: false,
          synthetic: true,
          origin: 'reconstructed',
          tools: [],
        })
      }
    }
    // Компакт — обвал префикса, а не любое его уменьшение: мелкая просадка
    // бывает и без сжатия контекста. Порог тот же, что в парсере.
    if (last) {
      const prefix = last.cacheRead + last.cacheWrite
      r.compacted = prefix > 10_000 && r.cacheRead < prefix * 0.6
    }
    requests.push(r)
    last = r
  }
  requests.forEach((r, i) => (r.seq = i))

  const totals = requests.reduce(
    (acc, r) => ({
      input: acc.input + r.input,
      output: acc.output + r.output,
      cacheWrite: acc.cacheWrite + r.cacheWrite,
      cacheRead: acc.cacheRead + r.cacheRead,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  )
  return { session, requests, totals, unknownTypes }
}

/**
 * Ожидаемый разбор роллаута Codex.
 *
 * Один `token_count` с непустым `info` — один запрос, и его стоимость лежит в
 * `last_token_usage`, а не в `total_token_usage`: второе накопительное.
 * `cached_input_tokens` — подмножество `input_tokens`, поэтому свежий ввод это
 * их разность.
 */
function buildExpectedCodex(lines: unknown[]): Record<string, unknown> {
  const session: Record<string, unknown> = {}
  const requests: Record<string, unknown>[] = []
  const limits: Record<string, unknown>[] = []
  const tools: Record<string, unknown>[] = []
  let contextWindow: number | undefined
  let lastTotal: Record<string, number> | undefined

  for (const raw of lines) {
    const r = raw as Record<string, any>
    const p = r['payload'] ?? {}
    if (r['type'] === 'session_meta') {
      session['id'] = p.id
      session['cwd'] = p.cwd
      session['cliVersion'] = p.cli_version
      session['originator'] = p.originator
      session['startedAt'] = p.timestamp
    }
    session['endedAt'] = r['timestamp']

    if (p.type === 'task_started' && p.model_context_window) contextWindow = p.model_context_window
    if (p.type === 'function_call') {
      tools.push({ name: p.name, kind: 'builtin', callId: p.call_id })
    }
    if (p.type === 'mcp_tool_call_end') {
      tools.push({
        name: `${p.invocation?.server}__${p.invocation?.tool}`,
        kind: 'mcp',
        server: p.invocation?.server,
        callId: p.call_id,
      })
    }
    if (p.type !== 'token_count') continue

    if (p.rate_limits) {
      for (const kind of ['primary', 'secondary'] as const) {
        const w = p.rate_limits[kind]
        if (!w) continue
        limits.push({
          kind,
          usedPercent: w.used_percent,
          windowMinutes: w.window_minutes,
          resetsAt: w.resets_at ? w.resets_at * 1000 : undefined,
          exact: true,
        })
      }
    }
    if (!p.info) continue
    const last = p.info.last_token_usage ?? {}
    lastTotal = p.info.total_token_usage ?? lastTotal
    requests.push({
      seq: requests.length,
      ts: r['timestamp'],
      input: (last.input_tokens ?? 0) - (last.cached_input_tokens ?? 0),
      cacheRead: last.cached_input_tokens ?? 0,
      cacheWrite: 0,
      output: last.output_tokens ?? 0,
      reasoning: last.reasoning_output_tokens ?? 0,
      contextWindow,
    })
  }

  const totals = requests.reduce(
    (a, r) => ({
      input: a.input + (r['input'] as number),
      output: a.output + (r['output'] as number),
      cacheRead: a.cacheRead + (r['cacheRead'] as number),
      reasoning: a.reasoning + (r['reasoning'] as number),
    }),
    { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
  )
  return {
    session,
    requests,
    limits,
    tools,
    totals,
    // Встроенная в формат сверка: сумма по запросам обязана сойтись с
    // накопительным итогом последнего token_count.
    totalTokenUsage: lastTotal,
  }
}

// ─── сборка ──────────────────────────────────────────────────────────────────

function readJsonl(path: string): unknown[] {
  const out: unknown[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // битую строку пропускаем: в живых логах бывает оборванный хвост
    }
  }
  return out
}

function writeFixture(dir: string, name: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

interface Scenario {
  name: string
  checks: string
  source: string
  withSubagents?: boolean
}

/**
 * Слепок эталона из ~/.claude.json: по проекту — id последней сессии и её
 * итоги, включая разбивку по моделям.
 *
 * Единственный независимый источник правды: цифры посчитаны самим Claude Code.
 * Файл перезаписывается при каждом запуске CLI, поэтому слепок снимается один
 * раз и коммитится. Имена проектов — псевдонимы, id сессий настоящие: по ним
 * `verify` ищет файлы на диске.
 */
function makeGroundTruth(): void {
  const cfgPath = join(homedir(), '.claude.json')
  if (!existsSync(cfgPath)) {
    console.error('  ground-truth: нет ~/.claude.json')
    return
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    projects?: Record<string, Record<string, unknown>>
  }
  const projects = Object.entries(cfg.projects ?? {})
    .filter(([, p]) => p['lastSessionId'] && (p['lastTotalCacheReadInputTokens'] as number))
    .map(([path, p], i) => ({
      project: `proj-${i.toString().padStart(2, '0')}`,
      sessionId: p['lastSessionId'],
      // slug каталога логов выводится из пути, поэтому его тоже прячем
      slugHash: createHash('sha256').update(path).digest('hex').slice(0, 12),
      totals: {
        input: p['lastTotalInputTokens'] ?? 0,
        output: p['lastTotalOutputTokens'] ?? 0,
        cacheWrite: p['lastTotalCacheCreationInputTokens'] ?? 0,
        cacheRead: p['lastTotalCacheReadInputTokens'] ?? 0,
      },
      byModel: p['lastModelUsage'] ?? {},
    }))
  mkdirSync(OUT, { recursive: true })
  writeFileSync(
    join(OUT, 'ground-truth.json'),
    JSON.stringify(
      {
        _: 'Эталон Claude Code, снят один раз. Только читать — пересъёмка обесценивает сверку.',
        takenAt: new Date().toISOString(),
        projects,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`  ground-truth: ${projects.length} проектов с эталонными суммами`)
}

function main(): void {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures.config.json'), 'utf8')) as {
    claude: Scenario[]
    codex: Scenario[]
  }

  for (const [provider, scenarios] of Object.entries({ claude: cfg.claude, codex: cfg.codex })) {
    for (const sc of scenarios) {
      const src = sc.source.replace(/^~/, homedir())
      if (!existsSync(src)) {
        console.error(`  пропуск ${sc.name}: нет ${src}`)
        continue
      }
      const dir = join(OUT, provider)
      const lines = readJsonl(src).map((l) => anonymize(l)) as unknown[]
      writeFixture(dir, sc.name, lines)

      if (provider === 'claude') {
        const expected = buildExpected(lines)
        writeFileSync(
          join(dir, `${sc.name}.expected.json`),
          JSON.stringify({ checks: sc.checks, ...expected }, null, 2) + '\n',
        )
        console.log(
          `  ${sc.name}: ${lines.length} записей, ${expected.requests.length} запросов ` +
            `(восстановлено ${expected.requests.filter((r) => r.origin === 'reconstructed').length})`,
        )
      } else {
        const expected = buildExpectedCodex(lines)
        writeFileSync(
          join(dir, `${sc.name}.expected.json`),
          JSON.stringify({ checks: sc.checks, ...expected }, null, 2) + '\n',
        )
        console.log(
          `  ${sc.name}: ${lines.length} записей, ` +
            `${(expected['requests'] as unknown[]).length} запросов, ` +
            `${(expected['limits'] as unknown[]).length} окон лимитов`,
        )
      }

      if (sc.withSubagents) {
        const subDir = join(dirname(src), basename(src, '.jsonl'), 'subagents')
        if (!existsSync(subDir)) {
          console.error(`  ${sc.name}: сабагентов нет в ${subDir}`)
          continue
        }
        for (const f of readdirSync(subDir)) {
          const full = join(subDir, f)
          const target = join(dir, `${sc.name}.subagents`)
          mkdirSync(target, { recursive: true })
          if (f.endsWith('.jsonl')) {
            const subLines = readJsonl(full).map((l) => anonymize(l))
            writeFileSync(join(target, f), subLines.map((l) => JSON.stringify(l)).join('\n') + '\n')
            const exp = buildExpected(subLines)
            writeFileSync(
              join(target, f.replace('.jsonl', '.expected.json')),
              JSON.stringify(exp, null, 2) + '\n',
            )
          } else if (f.endsWith('.meta.json')) {
            const meta = anonymize(JSON.parse(readFileSync(full, 'utf8')))
            writeFileSync(join(target, f), JSON.stringify(meta, null, 2) + '\n')
          }
        }
        console.log(`  ${sc.name}: сабагенты → ${sc.name}.subagents/`)
      }
    }
  }
  makeGroundTruth()
  console.log(`\nпсевдонимы проектов: ${[...projectAlias.entries()].map(([, a]) => a).join(', ')}`)
}

main()
