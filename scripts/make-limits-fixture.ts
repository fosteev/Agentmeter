/**
 * Собирает синтетические логи для ручного эталона 1.8. Числа живут в
 * `fixtures/limits/README.md`; expected JSON намеренно не читается и не пишется.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'fixtures', 'limits')
mkdirSync(dir, { recursive: true })

const ms = (iso: string): number => Date.parse(iso)
const sec = (iso: string): number => Math.round(ms(iso) / 1000)

// ——— Codex ———

interface Slot {
  used_percent: number
  window_minutes: number
  resets_at: number
}

function codexTokenCount(ts: string, total: number, primary: Slot | null, secondary: Slot | null): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total,
          cached_input_tokens: Math.round(total * 0.9),
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: total,
          cached_input_tokens: Math.round(total * 0.9),
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: total,
        },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary,
        secondary,
        credits: null,
        plan_type: 'plus',
      },
    },
  })
}

function codexMeta(id: string, ts: string, version: string, cwd: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'session_meta',
    payload: { id, timestamp: ts, cwd, originator: 'codex-tui', cli_version: version },
  })
}

/** Старая раскладка слотов: primary = 300, secondary = 10080. */
function codexOld(): string {
  const weekly = (pct: number): Slot => ({
    used_percent: pct,
    window_minutes: 10080,
    resets_at: sec('2026-05-05T09:00:00Z'),
  })
  const five = (pct: number, resets: string): Slot => ({
    used_percent: pct,
    window_minutes: 300,
    resets_at: sec(resets),
  })
  const lines = [
    codexMeta('019eca75-8888-7000-a000-000000000001', '2026-05-01T09:59:00.000Z', '0.129.0', '/fixture/codex-limits'),
    // 1 — окно открылось: 15:00 − 5 ч = 10:00
    codexTokenCount('2026-05-01T10:00:00.000Z', 100_000, five(1, '2026-05-01T15:00:00Z'), weekly(20)),
    // 2 — resets_at дрогнул на 2 с, окно то же
    codexTokenCount('2026-05-01T11:00:00.000Z', 1_200_000, five(12, '2026-05-01T15:00:02Z'), weekly(21)),
    // 3 — протухшее наблюдение: 3% посреди окна, стоящего на 12%
    codexTokenCount('2026-05-01T12:00:00.000Z', 1_300_000, five(3, '2026-05-01T15:00:00Z'), weekly(21)),
    // 4 — максимум окна
    codexTokenCount('2026-05-01T13:00:00.000Z', 3_000_000, five(30, '2026-05-01T15:00:00Z'), weekly(23)),
    // 5 — прежнее окно истекло, новый якорь: 21:00 − 5 ч = 16:00
    codexTokenCount('2026-05-01T16:00:00.000Z', 3_200_000, five(2, '2026-05-01T21:00:00Z'), weekly(24)),
  ]
  return lines.join('\n') + '\n'
}

/** Раскладка после 0.145.0: primary = недельное, secondary = null. */
function codexNew(): string {
  const weekly = (pct: number): Slot => ({
    used_percent: pct,
    window_minutes: 10080,
    resets_at: sec('2026-08-10T07:00:00Z'),
  })
  const lines = [
    codexMeta('019eca75-8888-7000-a000-000000000002', '2026-08-09T11:59:00.000Z', '0.147.0-alpha.6.5', '/fixture/codex-limits-new'),
    codexTokenCount('2026-08-09T12:00:00.000Z', 500_000, weekly(15), null),
    codexTokenCount('2026-08-09T13:00:00.000Z', 700_000, weekly(16), null),
  ]
  return lines.join('\n') + '\n'
}

/** Месячная и незнакомая длина окна — правило 1.4 в лоб. */
function codexOdd(): string {
  const lines = [
    codexMeta('019eca75-8888-7000-a000-000000000003', '2026-05-20T07:59:00.000Z', '0.139.0', '/fixture/codex-limits-odd'),
    codexTokenCount('2026-05-20T08:00:00.000Z', 200_000, {
      used_percent: 7,
      window_minutes: 43200,
      resets_at: sec('2026-06-01T08:00:00Z'),
    }, null),
    codexTokenCount('2026-05-20T09:00:00.000Z', 300_000, {
      used_percent: 4,
      window_minutes: 1440,
      resets_at: sec('2026-05-21T09:00:00Z'),
    }, null),
  ]
  return lines.join('\n') + '\n'
}

// ——— Claude ———

interface Turn {
  ts: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

const TURNS: Turn[] = [
  { ts: '2026-05-01T10:00:00.000Z', input: 1000, cacheWrite: 20000, cacheRead: 0, output: 500 },
  { ts: '2026-05-01T11:00:00.000Z', input: 100, cacheWrite: 5000, cacheRead: 100000, output: 400 },
  { ts: '2026-05-01T14:59:00.000Z', input: 100, cacheWrite: 1000, cacheRead: 200000, output: 300 },
  { ts: '2026-05-01T15:30:00.000Z', input: 100, cacheWrite: 2000, cacheRead: 300000, output: 100 },
]

function claudeLimits(): string {
  const base = {
    isSidechain: false,
    userType: 'external',
    cwd: '/fixture/claude-limits',
    sessionId: 'claude-limits',
    version: '2.1.226',
    gitBranch: 'fixture',
    entrypoint: 'cli',
  }
  const uuid = (n: number): string => `0195c1a0-8888-4000-8000-${String(n).padStart(12, '0')}`
  const lines: string[] = [
    JSON.stringify({
      ...base,
      uuid: uuid(1),
      timestamp: '2026-05-01T09:59:59.000Z',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'эталон окон лимита' },
    }),
  ]
  TURNS.forEach((turn, i) => {
    lines.push(JSON.stringify({
      ...base,
      uuid: uuid(i + 2),
      timestamp: turn.ts,
      type: 'assistant',
      requestId: `req_${String(i).padStart(3, '0')}`,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: turn.input,
          cache_creation_input_tokens: turn.cacheWrite,
          cache_read_input_tokens: turn.cacheRead,
          output_tokens: turn.output,
        },
      },
    }))
  })
  return lines.join('\n') + '\n'
}

// Цепочка кэша здесь намеренно разрывов не даёт: 1.3 к окнам лимита отношения
// не имеет, и восстановленные запросы не должны появиться из ниоткуда.
const files: [string, string][] = [
  ['codex-limits.jsonl', codexOld()],
  ['codex-limits-new.jsonl', codexNew()],
  ['codex-limits-odd.jsonl', codexOdd()],
  ['claude-limits.jsonl', claudeLimits()],
]

for (const [name, content] of files) {
  writeFileSync(join(dir, name), content)
  console.log(`${name}: ${content.trim().split('\n').length} записей`)
}

// Самопроверка раскладки, а не расчёта: числа из README должны лечь в файлы
// ровно как записаны. Ожидаемые окна здесь не считаются принципиально.
const weighted = TURNS.map(t => t.input + t.cacheWrite + t.output + 0.1 * t.cacheRead)
console.log(`claude: взвешенный расход по запросам ${weighted.join(', ')} (README: 21500, 15500, 21400, 32200)`)
console.log(`  ${ms('2026-05-01T14:59:00Z') < ms('2026-05-01T15:00:00Z') ? '✓' : '✗'} запрос 3 внутри первого окна`)
console.log(`  ${ms('2026-05-01T15:30:00Z') >= ms('2026-05-01T15:00:00Z') ? '✓' : '✗'} запрос 4 открывает второе`)
