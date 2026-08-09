/**
 * Сборка эталона атрибуции (1.6) — `fixtures/attribution/`.
 *
 * Это не пересборка из живых логов, как `make-fixtures.ts`. Цифры здесь
 * придуманы руками так, чтобы маржинальная стоимость каждого вызова считалась
 * в уме и проверялась глазами: разложение записано в
 * `fixtures/attribution/README.md`, и оно первично по отношению к любому коду.
 * Скрипт только раскладывает эти числа по записям нужного формата и добивает
 * результаты тулов до заданной длины в байтах.
 *
 * **Ожидаемые `marginalTokens` в `*.expected.json` посчитаны человеком.**
 * Пересобирать их выводом реализации нельзя ни при каких обстоятельствах —
 * тогда фикстура начнёт подтверждать сама себя, а вместе с ней и ошибку.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'fixtures', 'attribution')
mkdirSync(dir, { recursive: true })

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
/** Строка ровно `n` символов — длина фикстуры это её предмет, а не оформление. */
function pad(n: number): string {
  if (n <= 0) return ''
  return FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n)
}

// ── Claude ────────────────────────────────────────────────────────────────

interface ClaudeTool {
  id: string
  name: string
  /** `JSON.stringify(content).length` — ровно столько увидит парсер. */
  bytes: number
  image?: boolean
}

interface ClaudeStep {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  tools: ClaudeTool[]
  /** Текст, который пользователь дописал после этого запроса. */
  interjection?: string
}

const claudeSteps: ClaudeStep[] = [
  { input: 10, cacheRead: 0, cacheWrite: 20_000, output: 100, tools: [t('A', 'Read', 5400)] },
  {
    input: 10,
    cacheRead: 20_000,
    cacheWrite: 2100,
    output: 200,
    tools: [t('B', 'Bash', 2700), t('C', 'Bash', 8000)],
  },
  {
    input: 10,
    cacheRead: 22_100,
    cacheWrite: 4200,
    output: 300,
    tools: [t('D', 'Read', 27_000, true), t('E', 'Bash', 2700)],
  },
  {
    input: 10,
    cacheRead: 26_300,
    cacheWrite: 2400,
    output: 400,
    tools: [t('F', 'Bash', 1350), t('G', 'Bash', 1350)],
  },
  // Следом за этим запросом парсер вставит реконструированный: cacheRead
  // следующего больше ожидаемого на 500.
  { input: 10, cacheRead: 28_700, cacheWrite: 901, output: 500, tools: [t('H', 'Agent', 1200)] },
  {
    input: 10,
    cacheRead: 30_101,
    cacheWrite: 900,
    output: 600,
    tools: [t('I', 'Bash', 1350)],
    interjection: pad(300),
  },
  { input: 10, cacheRead: 31_001, cacheWrite: 1400, output: 700, tools: [t('J', 'Bash', 2700)] },
  // Компакт: префикс обвалился с 32 401 до 8000.
  { input: 10, cacheRead: 8000, cacheWrite: 12_000, output: 800, tools: [t('K', 'Bash', 5400)] },
  { input: 10, cacheRead: 20_000, cacheWrite: 2800, output: 900, tools: [t('L', 'Bash', 200)] },
  { input: 10, cacheRead: 22_800, cacheWrite: 850, output: 1000, tools: [] },
  { input: 10, cacheRead: 23_650, cacheWrite: 1060, output: 1100, tools: [t('M', 'Bash', 800)] },
]

function t(id: string, name: string, bytes: number, image = false): ClaudeTool {
  return image ? { id: `toolu_${id}`, name, bytes, image } : { id: `toolu_${id}`, name, bytes }
}

/** Результат-текст: `JSON.stringify("…")` длиннее строки ровно на две кавычки. */
function textResult(bytes: number): unknown {
  return pad(bytes - 2)
}

/** Результат-картинка: base64 в лог попал, добиваем блок до нужной длины. */
function imageResult(bytes: number): unknown {
  const block = (data: string): unknown => [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ]
  const overhead = JSON.stringify(block('')).length
  return block(pad(bytes - overhead))
}

function claudeLines(): string[] {
  const lines: string[] = []
  const sessionId = '0195c1a0-1111-4000-8000-00000000c0de'
  let ts = Date.parse('2026-08-09T10:00:00.000Z')
  const stamp = (): string => new Date((ts += 30_000)).toISOString()
  let uuid = 0
  const next = (): string => `0195c1a0-2222-4000-8000-${String(++uuid).padStart(12, '0')}`

  const common = {
    isSidechain: false,
    userType: 'external',
    cwd: '/proj/a',
    sessionId,
    version: '2.1.223',
    gitBranch: 'feature/one',
    entrypoint: 'cli',
  }

  lines.push(
    JSON.stringify({
      ...common,
      parentUuid: null,
      uuid: next(),
      timestamp: stamp(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: pad(400) }] },
    }),
  )

  claudeSteps.forEach((step, seq) => {
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
          model: 'claude-opus-5',
          content: [
            { type: 'text', text: pad(80) },
            ...step.tools.map((tool) => ({
              type: 'tool_use',
              id: tool.id,
              name: tool.name,
              input: { command: pad(20) },
            })),
          ],
          stop_reason: step.tools.length > 0 ? 'tool_use' : 'end_turn',
          usage: {
            input_tokens: step.input,
            cache_creation_input_tokens: step.cacheWrite,
            cache_read_input_tokens: step.cacheRead,
            output_tokens: step.output,
            cache_creation: {
              ephemeral_5m_input_tokens: step.cacheWrite,
              ephemeral_1h_input_tokens: 0,
            },
          },
        },
      }),
    )

    for (const tool of step.tools) {
      lines.push(
        JSON.stringify({
          ...common,
          parentUuid: next(),
          uuid: next(),
          timestamp: stamp(),
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: tool.id,
                content: tool.image ? imageResult(tool.bytes) : textResult(tool.bytes),
              },
            ],
          },
        }),
      )
    }

    if (step.interjection !== undefined) {
      lines.push(
        JSON.stringify({
          ...common,
          parentUuid: next(),
          uuid: next(),
          timestamp: stamp(),
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: step.interjection }] },
        }),
      )
    }
  })

  return lines
}

// ── Codex ─────────────────────────────────────────────────────────────────

interface CodexTool {
  id: string
  name: string
  /** Байты строки-результата. `undefined` — записи с результатом в логе нет. */
  bytes?: number
}

interface CodexStep {
  /** `input_tokens` — весь промпт запроса, вместе с кэшированной частью. */
  ctx: number
  cached: number
  output: number
  reasoning: number
  tools: CodexTool[]
  /** Перед этим запросом контекст сжали. */
  compacted?: boolean
  /** Повторить `token_count` с тем же накопительным итогом — дедуп 1.2. */
  duplicate?: boolean
}

const codexSteps: CodexStep[] = [
  { ctx: 10_000, cached: 0, output: 200, reasoning: 50, tools: [c('P', 'exec_command', 2700)] },
  {
    ctx: 12_500,
    cached: 10_000,
    output: 300,
    reasoning: 100,
    tools: [c('Q', 'exec_command', 5400), c('R', 'exec_command', 1350)],
  },
  {
    ctx: 15_000,
    cached: 12_000,
    output: 400,
    reasoning: 0,
    tools: [c('S', 'exec_command', 0), c('T', 'exec_command', 0)],
  },
  {
    ctx: 17_000,
    cached: 15_000,
    output: 500,
    reasoning: 0,
    tools: [c('U', 'view_image', 0), c('V', 'exec_command', 2700)],
  },
  {
    ctx: 19_000,
    cached: 17_000,
    output: 600,
    reasoning: 0,
    tools: [c('W', 'exec_command', 2700)],
    duplicate: true,
  },
  {
    ctx: 6000,
    cached: 0,
    output: 700,
    reasoning: 0,
    tools: [c('X', 'exec_command', 2700)],
    compacted: true,
  },
  { ctx: 8000, cached: 6000, output: 800, reasoning: 0, tools: [] },
  { ctx: 9000, cached: 8000, output: 900, reasoning: 0, tools: [c('Y', 'exec_command', 800)] },
]

function c(id: string, name: string, bytes: number): CodexTool {
  return { id: `call_${id}`, name, bytes }
}

function codexLines(): string[] {
  const lines: string[] = []
  let ts = Date.parse('2026-08-09T12:00:00.000Z')
  const stamp = (): string => new Date((ts += 30_000)).toISOString()
  const turnId = '019eca75-3333-7000-a000-000000000001'
  const rec = (type: string, payload: unknown): void => {
    lines.push(JSON.stringify({ timestamp: stamp(), type, payload }))
  }

  rec('session_meta', {
    id: '019eca75-4444-7000-a000-0000000000ab',
    timestamp: new Date(ts).toISOString(),
    cwd: '/proj/a',
    originator: 'codex-tui',
    cli_version: '0.139.0',
    source: 'cli',
    model_provider: 'openai',
    git: { branch: 'feature/one' },
  })
  rec('event_msg', {
    type: 'task_started',
    turn_id: turnId,
    model_context_window: 258_400,
  })
  rec('turn_context', { turn_id: turnId, model: 'gpt-5.3-codex' })
  rec('event_msg', { type: 'user_message', message: pad(400) })

  const total = { input: 0, cached: 0, output: 0, reasoning: 0 }
  for (const step of codexSteps) {
    if (step.compacted) rec('event_msg', { type: 'context_compacted' })

    for (const tool of step.tools)
      rec('response_item', {
        type: 'function_call',
        call_id: tool.id,
        name: tool.name,
        arguments: JSON.stringify({ command: pad(20) }),
      })

    total.input += step.ctx
    total.cached += step.cached
    total.output += step.output
    total.reasoning += step.reasoning
    const tokenCount = {
      type: 'token_count',
      info: {
        model_context_window: 258_400,
        last_token_usage: {
          input_tokens: step.ctx,
          cached_input_tokens: step.cached,
          output_tokens: step.output,
          reasoning_output_tokens: step.reasoning,
          total_tokens: step.ctx + step.output,
        },
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          output_tokens: total.output,
          reasoning_output_tokens: total.reasoning,
          total_tokens: total.input + total.output,
        },
      },
    }
    rec('event_msg', tokenCount)
    // Тот же ответ, записанный дважды: накопительный итог не сдвинулся.
    if (step.duplicate) rec('event_msg', tokenCount)

    for (const tool of step.tools) {
      if (tool.bytes === undefined) continue
      rec('response_item', {
        type: 'function_call_output',
        call_id: tool.id,
        output: pad(tool.bytes),
      })
    }
  }

  return lines
}

writeFileSync(join(dir, 'claude-chain.jsonl'), `${claudeLines().join('\n')}\n`)
writeFileSync(join(dir, 'codex-chain.jsonl'), `${codexLines().join('\n')}\n`)
console.log('fixtures/attribution/claude-chain.jsonl, codex-chain.jsonl — собраны')
