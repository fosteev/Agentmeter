/**
 * Сборка эталона скорости модели (8.4) — `fixtures/speed/`.
 *
 *     node --experimental-strip-types scripts/make-speed-fixture.ts
 *
 * Метки придуманы так, чтобы время ответа и медианы считались в уме, и
 * разложены по строкам в `fixtures/speed/README.md`. Скрипт только
 * раскладывает их по записям нужного формата.
 *
 * **`expected.json` посчитан человеком и этим скриптом не пишется.** Соберись
 * он выводом реализации — эталон подтвердил бы и конец по `token_count`, и
 * старт перед последней строкой: числа вышли бы, просто не те.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'fixtures', 'speed')
mkdirSync(dir, { recursive: true })

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
function pad(n: number): string {
  return FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n)
}

// ── Claude ────────────────────────────────────────────────────────────────

const CLAUDE_DAY = '2026-09-01T10:'
const SESSION = '0195d1a0-5555-4000-8000-0000000005ed'

/** `MM:SS.mmm` после 10:00 → ISO; полная метка проходит как есть. */
function at(time: string): string {
  return time.includes('T') ? time : `${CLAUDE_DAY}${time}Z`
}

function claudeLines(): string[] {
  const lines: string[] = []
  let uuid = 0
  const next = (): string => `0195d1a0-5555-4000-8000-${String(++uuid).padStart(12, '0')}`
  const common = {
    isSidechain: false,
    userType: 'external',
    cwd: '/work/alpha',
    sessionId: SESSION,
    version: '2.1.308',
    gitBranch: 'main',
    entrypoint: 'cli',
  }
  // Цепочка кэша без разрывов, кроме одного — перед r3 (см. README).
  let cacheRead = 0
  const push = (record: Record<string, unknown>): void => {
    lines.push(JSON.stringify(record))
  }
  const prompt = (time: string): void =>
    push({
      ...common,
      parentUuid: null,
      uuid: next(),
      timestamp: at(time),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: pad(120) }] },
    })
  const toolResult = (time: string, id: string): void =>
    push({
      ...common,
      parentUuid: null,
      uuid: next(),
      timestamp: at(time),
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: pad(60) }],
      },
    })
  const attachment = (time: string, attachment: Record<string, unknown>): void =>
    push({ ...common, parentUuid: null, uuid: next(), timestamp: at(time), type: 'attachment', attachment })
  const answer = (options: {
    time: string
    requestId: string
    model: string
    output: number
    block: Record<string, unknown>
    /** Кэш перед этим ответом; по умолчанию — продолжение цепочки. */
    cacheRead?: number
  }): void => {
    push({
      ...common,
      parentUuid: null,
      uuid: next(),
      timestamp: at(options.time),
      type: 'assistant',
      requestId: options.requestId,
      message: {
        id: `msg_${options.requestId.slice(4)}`,
        type: 'message',
        role: 'assistant',
        model: options.model,
        content: [options.block],
        stop_reason: options.block.type === 'tool_use' ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: options.cacheRead ?? cacheRead,
          output_tokens: options.output,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
        },
      },
    })
  }
  const text = { type: 'text', text: pad(80) }
  const tool = (id: string): Record<string, unknown> => ({
    type: 'tool_use',
    id,
    name: 'Read',
    input: { file_path: '/work/alpha/notes.md' },
  })
  /** Запрос закончен: следующий читает из кэша всё, что этот записал. */
  const done = (): void => {
    cacheRead += 100
  }

  // s0 — первая запись файла: записи-старта у него нет.
  cacheRead = 0
  answer({
    time: '2026-09-01T09:59:58.000Z',
    requestId: 'req_s0',
    model: 'claude-sonnet-5',
    output: 100,
    block: text,
  })
  done()

  // r0
  prompt('00:00.000')
  answer({ time: '00:04.000', requestId: 'req_r0', model: 'claude-opus-5', output: 200, block: tool('toolu_r0') })
  done()

  // r1 — три строки, между второй и третьей ложится результат инструмента.
  toolResult('00:05.000', 'toolu_r0')
  answer({
    time: '00:08.000',
    requestId: 'req_r1',
    model: 'claude-opus-5',
    output: 200,
    block: { type: 'thinking', thinking: pad(40), signature: 'sig' },
  })
  answer({ time: '00:09.000', requestId: 'req_r1', model: 'claude-opus-5', output: 400, block: tool('toolu_r1a') })
  toolResult('00:09.500', 'toolu_r1a')
  answer({ time: '00:11.000', requestId: 'req_r1', model: 'claude-opus-5', output: 600, block: tool('toolu_r1b') })
  done()

  // r2 — `deferred_tools_record` пишется вместе с ответом.
  toolResult('00:11.800', 'toolu_r1b')
  attachment('00:12.000', { type: 'total_tokens_reminder', content: pad(30) })
  attachment('00:20.000', { type: 'deferred_tools_record', entries: [], toolInputCopies: [] })
  answer({ time: '00:20.000', requestId: 'req_r2', model: 'claude-opus-5', output: 160, block: text })
  done()

  // r3 — между r2 и r3 рвётся цепочка кэша: 1800 вместо ожидаемых 400.
  prompt('01:00.000')
  answer({
    time: '01:10.000',
    requestId: 'req_r3',
    model: 'claude-opus-5',
    output: 100,
    block: text,
    cacheRead: 1800,
  })
  cacheRead = 1900

  // r4 — ответ помечен раньше своего промпта.
  prompt('01:30.000')
  answer({ time: '01:29.000', requestId: 'req_r4', model: 'claude-opus-5', output: 50, block: text })
  done()

  // r5 — `file-history-delta` с меткой позже ответа.
  prompt('02:00.000')
  push({
    type: 'file-history-delta',
    timestamp: at('02:30.000'),
    sessionId: SESSION,
    messageId: 'msg_r5',
  })
  answer({ time: '02:05.000', requestId: 'req_r5', model: 'claude-opus-5', output: 400, block: text })
  done()

  // r6 — сообщение в очередь, пока модель работала.
  prompt('03:00.000')
  push({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: at('03:02.000'),
    sessionId: SESSION,
    content: pad(20),
  })
  answer({ time: '03:03.000', requestId: 'req_r6', model: 'claude-opus-5', output: 90, block: text })
  done()

  // s1, s2 — вторая модель, два измерения: ниже порога.
  prompt('04:00.000')
  answer({ time: '04:02.000', requestId: 'req_s1', model: 'claude-sonnet-5', output: 100, block: text })
  done()
  prompt('05:00.000')
  answer({ time: '05:04.000', requestId: 'req_s2', model: 'claude-sonnet-5', output: 100, block: text })
  done()

  return lines
}

// ── Codex ─────────────────────────────────────────────────────────────────

const CODEX_SESSION = '019ecb75-5555-7000-a000-0000000005ed'

function codexLines(): string[] {
  const lines: string[] = []
  const rec = (time: string, type: string, payload: unknown): void => {
    lines.push(JSON.stringify({ timestamp: `2026-09-01T12:${time}Z`, type, payload }))
  }
  const total = { input: 0, cached: 0, output: 0 }
  let ctx = 1000
  const tokenCount = (time: string, output: number, repeat = false): void => {
    if (!repeat) {
      ctx += 500
      total.input += ctx
      total.cached += ctx - 500
      total.output += output
    }
    rec(time, 'event_msg', {
      type: 'token_count',
      info: {
        model_context_window: 258_400,
        last_token_usage: {
          input_tokens: ctx,
          cached_input_tokens: ctx - 500,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: ctx + output,
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
  const turn = (time: string, turnId: string): void => {
    rec(time, 'event_msg', { type: 'task_started', turn_id: turnId, model_context_window: 258_400 })
    rec(time, 'turn_context', { turn_id: turnId, model: 'gpt-5.6-sol', cwd: '/work/alpha' })
  }
  const userMessage = (time: string): void =>
    rec(time, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: pad(120) }],
    })
  const userEvent = (time: string): void =>
    rec(time, 'event_msg', { type: 'user_message', message: pad(120) })
  const reasoning = (time: string): void =>
    rec(time, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'x' })
  const call = (time: string, id: string): void =>
    rec(time, 'response_item', {
      type: 'function_call',
      name: 'shell',
      arguments: JSON.stringify({ command: ['ls'] }),
      call_id: id,
    })
  const output = (time: string, id: string): void =>
    rec(time, 'response_item', { type: 'function_call_output', call_id: id, output: pad(60) })
  const assistant = (time: string): void =>
    rec(time, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: pad(80) }],
    })

  rec('00:00.000', 'session_meta', {
    id: CODEX_SESSION,
    timestamp: '2026-09-01T12:00:00.000Z',
    cwd: '/work/alpha',
    originator: 'codex-tui',
    cli_version: '0.145.0',
    source: 'cli',
    model_provider: 'openai',
    git: { branch: 'main' },
  })

  // c0
  turn('00:00.000', '019ecb75-5555-7000-a000-00000000000a')
  userMessage('00:00.500')
  userEvent('00:00.600')
  reasoning('00:02.000')
  call('00:03.000', 'call_c0')
  output('00:05.000', 'call_c0')
  tokenCount('00:05.000', 120)
  // Повтор того же ответа: итог не сдвинулся.
  tokenCount('00:06.000', 120, true)

  // c1
  reasoning('00:07.000')
  call('00:08.000', 'call_c1')
  output('00:09.000', 'call_c1')
  tokenCount('00:09.000', 300)

  // c2 — после компакта.
  rec('00:20.000', 'compacted', { message: pad(40) })
  rec('00:20.000', 'event_msg', { type: 'context_compacted' })
  reasoning('00:23.000')
  assistant('00:25.000')
  tokenCount('00:25.050', 500)

  // c3 — новый ход.
  turn('01:00.000', '019ecb75-5555-7000-a000-00000000000b')
  userMessage('01:00.100')
  userEvent('01:00.200')
  assistant('01:04.200')
  tokenCount('01:04.300', 80)

  // c4 — человек дописал, инструмент работал девять секунд.
  userEvent('01:06.000')
  rec('01:11.000', 'response_item', {
    type: 'custom_tool_call',
    name: 'apply_patch',
    input: '*** Begin Patch\n*** Update File: notes.md\n@@\n-a\n+b\n*** End Patch\n',
    call_id: 'call_c4',
  })
  rec('01:20.000', 'response_item', { type: 'custom_tool_call_output', call_id: 'call_c4', output: pad(40) })
  tokenCount('01:20.010', 150)

  // c5 — `token_count` раньше результата.
  reasoning('01:26.000')
  call('01:28.000', 'call_c5')
  tokenCount('01:28.010', 800)
  output('01:40.000', 'call_c5')

  return lines
}

const files: Array<[string, string[]]> = [
  ['claude-alpha.jsonl', claudeLines()],
  ['codex-alpha.jsonl', codexLines()],
]

for (const [name, lines] of files) writeFileSync(join(dir, name), `${lines.join('\n')}\n`)
console.log(`fixtures/speed/ — собраны: ${files.map(([name]) => name).join(', ')}`)
