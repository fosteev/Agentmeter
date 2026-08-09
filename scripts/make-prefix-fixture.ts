/**
 * Собирает синтетические логи для ручного эталона 1.7. Числа живут в
 * `fixtures/prefix/README.md`; expected JSON намеренно не читается и не пишется.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'fixtures', 'prefix')
mkdirSync(dir, { recursive: true })

const FILLER = 'данные prefix fixture lorem ipsum '

function padBytes(bytes: number): string {
  let remaining = bytes
  const chunks: string[] = []
  const fillerBytes = Buffer.byteLength(FILLER, 'utf8')
  while (remaining >= fillerBytes) {
    chunks.push(FILLER)
    remaining -= fillerBytes
  }
  for (const char of FILLER) {
    const size = Buffer.byteLength(char, 'utf8')
    if (size > remaining) continue
    chunks.push(char)
    remaining -= size
    if (remaining === 0) break
  }
  if (remaining > 0) chunks.push('x'.repeat(remaining))
  const result = chunks.join('')
  if (Buffer.byteLength(result, 'utf8') !== bytes) throw new Error(`padBytes(${bytes})`)
  return result
}

function exactName(prefix: string, bytes: number): string {
  const rest = bytes - Buffer.byteLength(prefix, 'utf8')
  if (rest < 1) throw new Error(`name prefix is longer than ${bytes} bytes`)
  return `${prefix}${'x'.repeat(rest)}`
}

function splitNames(prefix: string, count: number, totalBytes: number): string[] {
  const base = Math.floor(totalBytes / count)
  return Array.from({ length: count }, (_, index) =>
    exactName(`${prefix}${index}_`, base + (index < totalBytes % count ? 1 : 0)),
  )
}

function claudeLines(options: {
  sessionId: string
  prefixTokens: number
  requests: number
  eager: boolean
}): string[] {
  const lines: string[] = []
  let ts = Date.parse('2026-08-09T10:00:00.000Z')
  let uuid = 0
  const stamp = (): string => new Date((ts += 1000)).toISOString()
  const next = (): string => `0195c1a0-1111-4000-8000-${String(++uuid).padStart(12, '0')}`
  const common = {
    isSidechain: false,
    userType: 'external',
    cwd: `/fixture/${options.sessionId}`,
    sessionId: options.sessionId,
    version: '2.1.226',
    gitBranch: 'fixture',
    entrypoint: 'cli',
  }
  const push = (record: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...common, uuid: next(), timestamp: stamp(), ...record }))
  }

  push({
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: padBytes(3020) },
  })
  push({ type: 'attachment', attachment: { type: 'skill_listing', content: padBytes(4050) } })

  if (!options.eager) {
    const builtins = splitNames('Builtin', 5, 1295)
    const mcp = splitNames('mcp__serena__tool', 5, 1296)
    push({
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: [...mcp, ...builtins],
        addedLines: [...mcp, ...builtins],
      },
    })
    push({
      type: 'attachment',
      attachment: { type: 'agent_listing_delta', addedLines: [padBytes(4220)] },
    })
    push({
      type: 'attachment',
      attachment: {
        type: 'mcp_instructions_delta',
        addedNames: ['serena'],
        addedBlocks: [padBytes(3680)],
      },
    })
    push({
      type: 'attachment',
      attachment: {
        type: 'nested_memory',
        path: '/fixture/memory/CLAUDE.md',
        content: { path: '/fixture/memory/CLAUDE.md', type: 'Project', content: padBytes(4110) },
      },
    })
  }

  for (let seq = 0; seq < options.requests; seq += 1) {
    push({
      type: 'assistant',
      requestId: `req_${String(seq).padStart(3, '0')}`,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: seq === 0 ? options.prefixTokens : 0,
          cache_read_input_tokens: seq === 0 ? 0 : options.prefixTokens,
          output_tokens: 1,
        },
      },
    })
  }
  return lines
}

function codexLines(): string[] {
  const lines: string[] = []
  let ts = Date.parse('2026-08-09T12:00:00.000Z')
  const rec = (type: string, payload: unknown): void => {
    lines.push(JSON.stringify({ timestamp: new Date((ts += 1000)).toISOString(), type, payload }))
  }

  rec('session_meta', {
    id: '019eca75-4444-7000-a000-000000000017',
    timestamp: new Date(ts).toISOString(),
    cwd: '/fixture/codex-prefix',
    originator: 'codex-tui',
    cli_version: '0.145.0',
    base_instructions: { text: padBytes(12_330) },
  })
  rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: padBytes(4110) }],
  })
  rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: padBytes(3020) }],
  })
  rec('turn_context', { turn_id: 'turn-prefix', model: 'gpt-5.3-codex' })

  const total = { input: 0, cached: 0, output: 0, reasoning: 0 }
  for (let seq = 0; seq < 5; seq += 1) {
    const input = 9000
    const cached = seq === 0 ? 0 : 9000
    total.input += input
    total.cached += cached
    total.output += 1
    rec('event_msg', {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          output_tokens: total.output,
          reasoning_output_tokens: total.reasoning,
        },
      },
    })
  }
  return lines
}

writeFileSync(
  join(dir, 'claude-prefix.jsonl'),
  `${claudeLines({ sessionId: 'claude-prefix', prefixTokens: 30_000, requests: 12, eager: false }).join('\n')}\n`,
)
writeFileSync(
  join(dir, 'claude-eager.jsonl'),
  `${claudeLines({ sessionId: 'claude-eager', prefixTokens: 36_000, requests: 4, eager: true }).join('\n')}\n`,
)
writeFileSync(join(dir, 'codex-prefix.jsonl'), `${codexLines().join('\n')}\n`)
console.log('fixtures/prefix/*.jsonl — собраны; expected JSON не изменялись')
