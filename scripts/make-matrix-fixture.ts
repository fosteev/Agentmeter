/**
 * Сборка эталона клетки «проект × модель» (8.1) — `fixtures/matrix/`.
 *
 * Как и у атрибуции, это не срез живых логов: числа придуманы так, чтобы
 * матрица складывалась в уме, и разложены по строкам в
 * `fixtures/matrix/README.md`. Скрипт только раскладывает их по записям нужного
 * формата.
 *
 * **`expected.json` посчитан человеком и этим скриптом не пишется.** Соберись
 * он выводом реализации — фикстура начала бы подтверждать любую группировку,
 * включая ту, где сессия целиком уехала в модель своего первого запроса.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'fixtures', 'matrix')
mkdirSync(dir, { recursive: true })

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
function pad(n: number): string {
  return FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n)
}

// ── Claude ────────────────────────────────────────────────────────────────

interface ClaudeStep {
  model: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/**
 * Сессия проекта `alpha`: модель меняется на третьем запросе, а между третьим и
 * четвёртым цепочка кэша рвётся (1800 против ожидаемых 1100 + 200) — парсер
 * вставит туда восстановленный запрос, и модель он унаследует у соседа, то есть
 * `claude-fable-5`. Ради этой клетки фикстура и существует.
 */
const alphaSteps: ClaudeStep[] = [
  { model: 'claude-opus-5', input: 10, cacheWrite: 1000, cacheRead: 0, output: 100 },
  { model: 'claude-opus-5', input: 10, cacheWrite: 100, cacheRead: 1000, output: 200 },
  { model: 'claude-fable-5', input: 10, cacheWrite: 200, cacheRead: 1100, output: 300 },
  { model: 'claude-fable-5', input: 10, cacheWrite: 300, cacheRead: 1800, output: 400 },
]

/** Сессия проекта `beta`: одна модель на всю строку, цепочка кэша целая. */
const betaSteps: ClaudeStep[] = [
  { model: 'claude-opus-5', input: 10, cacheWrite: 500, cacheRead: 0, output: 50 },
  { model: 'claude-opus-5', input: 10, cacheWrite: 50, cacheRead: 500, output: 60 },
]

function claudeLines(options: {
  sessionId: string
  cwd: string
  branch: string
  start: string
  steps: ClaudeStep[]
}): string[] {
  const lines: string[] = []
  let ts = Date.parse(options.start)
  const stamp = (): string => new Date((ts += 30_000)).toISOString()
  let uuid = 0
  const next = (): string =>
    `${options.sessionId.slice(0, 8)}-2222-4000-8000-${String(++uuid).padStart(12, '0')}`

  const common = {
    isSidechain: false,
    userType: 'external',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: '2.1.223',
    gitBranch: options.branch,
    entrypoint: 'cli',
  }

  lines.push(
    JSON.stringify({
      ...common,
      parentUuid: null,
      uuid: next(),
      timestamp: stamp(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: pad(200) }] },
    }),
  )

  options.steps.forEach((step, seq) => {
    lines.push(
      JSON.stringify({
        ...common,
        parentUuid: next(),
        uuid: next(),
        timestamp: stamp(),
        type: 'assistant',
        requestId: `req_${String(seq).padStart(3, '0')}`,
        message: {
          id: `msg_${String(seq).padStart(3, '0')}`,
          type: 'message',
          role: 'assistant',
          model: step.model,
          content: [{ type: 'text', text: pad(80) }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: step.input,
            cache_creation_input_tokens: step.cacheWrite,
            cache_read_input_tokens: step.cacheRead,
            output_tokens: step.output,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: step.cacheWrite,
            },
          },
        },
      }),
    )
  })

  return lines
}

// ── Codex ─────────────────────────────────────────────────────────────────

interface CodexStep {
  /** `input_tokens` — весь промпт запроса, вместе с кэшированной частью. */
  ctx: number
  cached: number
  output: number
}

/** Тот же проект `alpha`, но второй провайдер: строка проекта смешанная. */
const codexSteps: CodexStep[] = [
  { ctx: 1000, cached: 0, output: 100 },
  { ctx: 1500, cached: 900, output: 150 },
]

function codexLines(options: {
  sessionId: string
  cwd: string
  branch: string
  start: string
  model: string
  steps: CodexStep[]
}): string[] {
  const lines: string[] = []
  let ts = Date.parse(options.start)
  const stamp = (): string => new Date((ts += 30_000)).toISOString()
  const turnId = '019eca75-3333-7000-a000-000000000001'
  const rec = (type: string, payload: unknown): void => {
    lines.push(JSON.stringify({ timestamp: stamp(), type, payload }))
  }

  rec('session_meta', {
    id: options.sessionId,
    timestamp: new Date(ts).toISOString(),
    cwd: options.cwd,
    originator: 'codex-tui',
    cli_version: '0.145.0',
    source: 'cli',
    model_provider: 'openai',
    git: { branch: options.branch },
  })
  rec('event_msg', { type: 'task_started', turn_id: turnId, model_context_window: 258_400 })
  rec('turn_context', { turn_id: turnId, model: options.model })
  rec('event_msg', { type: 'user_message', message: pad(200) })

  const total = { input: 0, cached: 0, output: 0 }
  for (const step of options.steps) {
    total.input += step.ctx
    total.cached += step.cached
    total.output += step.output
    rec('event_msg', {
      type: 'token_count',
      info: {
        model_context_window: 258_400,
        last_token_usage: {
          input_tokens: step.ctx,
          cached_input_tokens: step.cached,
          output_tokens: step.output,
          reasoning_output_tokens: 0,
          total_tokens: step.ctx + step.output,
        },
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          output_tokens: total.output,
          reasoning_output_tokens: 0,
          total_tokens: total.input + total.output,
        },
      },
    })
  }

  return lines
}

const files: Array<[string, string[]]> = [
  [
    'claude-alpha.jsonl',
    claudeLines({
      sessionId: '0195d1a0-1111-4000-8000-00000000a1fa',
      cwd: '/work/alpha',
      branch: 'feature/one',
      start: '2026-08-20T10:00:00.000Z',
      steps: alphaSteps,
    }),
  ],
  [
    'codex-alpha.jsonl',
    codexLines({
      sessionId: '019ecb75-4444-7000-a000-0000000000a1',
      cwd: '/work/alpha',
      branch: 'feature/one',
      start: '2026-08-20T12:00:00.000Z',
      model: 'gpt-5.6-sol',
      steps: codexSteps,
    }),
  ],
  [
    'claude-beta.jsonl',
    claudeLines({
      sessionId: '0195d1a0-1111-4000-8000-00000000be7a',
      cwd: '/work/beta',
      branch: 'main',
      start: '2026-08-21T10:00:00.000Z',
      steps: betaSteps,
    }),
  ],
]

for (const [name, lines] of files) writeFileSync(join(dir, name), `${lines.join('\n')}\n`)
console.log(`fixtures/matrix/ — собраны: ${files.map(([name]) => name).join(', ')}`)
