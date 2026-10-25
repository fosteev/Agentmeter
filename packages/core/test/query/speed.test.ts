/**
 * Скорость модели (8.4).
 *
 * Эталон — `fixtures/speed/`, где время каждого запроса посчитано человеком в
 * `README.md` до кода парсера. Каждая ловушка из брифа лежит там отдельным
 * запросом, поэтому мутация называется своим именем: «c4 — 14 010 вместо
 * 5000» читается как «конец взят по `token_count`», а не как «медиана
 * разошлась».
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ingestFile,
  modelSpeeds,
  parseRolloutFile,
  parseSessionFile,
  spendMatrix,
  SPEED,
  type ModelSpeed,
  type ParseResult,
  type RequestScope,
  type SourceFile,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'
import { SCHEMA_VERSION } from '../../src/index/schema.ts'

const speedDir = fileURLToPath(new URL('../../../../fixtures/speed/', import.meta.url))

interface ExpectedRequest {
  file: string
  seq: number
  requestId?: string
  model: string
  origin: 'log' | 'reconstructed'
  output: number
  durationMs: number | null
}

interface ExpectedCase {
  name: string
  from: string
  to: string
  scope: RequestScope
  speeds: Record<string, ModelSpeed>
}

const expected = JSON.parse(readFileSync(join(speedDir, 'expected.json'), 'utf8')) as {
  requests: ExpectedRequest[]
  cases: ExpectedCase[]
}

const FILES: SourceFile[] = [
  { path: join(speedDir, 'claude-alpha.jsonl'), provider: 'claude', kind: 'session' },
  { path: join(speedDir, 'codex-alpha.jsonl'), provider: 'codex', kind: 'session' },
]

const day = {
  from: Date.parse('2026-09-01T00:00:00.000Z'),
  to: Date.parse('2026-09-02T00:00:00.000Z'),
}

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-speed-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function parse(file: string): ParseResult {
  const path = join(speedDir, file)
  return file.startsWith('codex') ? parseRolloutFile(path) : parseSessionFile(path)
}

function expectedFor(file: string): ExpectedRequest[] {
  return expected.requests.filter((request) => request.file === file)
}

describe('время ответа на запросе', () => {
  it.each(['claude-alpha.jsonl', 'codex-alpha.jsonl'])('сходится с ручным расчётом: %s', (file) => {
    const requests = parse(file).requests.map((request) => ({
      seq: request.seq,
      model: request.model,
      origin: request.origin,
      output: request.output,
      durationMs: request.durationMs ?? null,
      ...(file.startsWith('claude') ? { requestId: request.requestId } : {}),
    }))
    expect(requests).toEqual(expectedFor(file).map(({ file: _file, ...rest }) => rest))
  })

  /**
   * У восстановленного запроса (1.3) в логе нет ни одной записи — мерить нечего.
   * Приписать ему время соседа значит добавить в выборку измерение, которого
   * не было: модель «отвечала» вдвое чаще, чем на самом деле.
   */
  it('у восстановленного времени нет — поле отсутствует, а не ноль', () => {
    const reconstructed = parse('claude-alpha.jsonl').requests.filter(
      (request) => request.origin === 'reconstructed',
    )
    expect(reconstructed).toHaveLength(1)
    expect('durationMs' in reconstructed[0]!).toBe(false)
  })

  it('время не бывает нулём или отрицательным', () => {
    for (const file of ['claude-alpha.jsonl', 'codex-alpha.jsonl']) {
      for (const request of parse(file).requests) {
        if (request.durationMs !== undefined) expect(request.durationMs).toBeGreaterThan(0)
      }
    }
  })

  /**
   * Самые дорогие ошибки этапа — по одной на провайдера, с числами из README,
   * чтобы поломка называлась своим именем.
   */
  it('Claude: старт — перед первой строкой запроса, а не перед последней', () => {
    const r1 = parse('claude-alpha.jsonl').requests.find((r) => r.requestId === 'req_r1')
    // Перед последней строкой лежит результат инструмента 00:09.500 → 1500.
    expect(r1?.durationMs).toBe(6000)
  })

  it('Claude: записи, написанные вместе с ответом, стартом не бывают', () => {
    const requests = parse('claude-alpha.jsonl').requests
    // deferred_tools_record — 0 мс, file-history-delta — минус, queue-operation — 1000.
    expect(requests.find((r) => r.requestId === 'req_r2')?.durationMs).toBe(8000)
    expect(requests.find((r) => r.requestId === 'req_r5')?.durationMs).toBe(5000)
    expect(requests.find((r) => r.requestId === 'req_r6')?.durationMs).toBe(3000)
  })

  it('Codex: конец — последний элемент ответа, а не token_count', () => {
    const requests = parse('codex-alpha.jsonl').requests
    // Инструмент работал 2 и 9 секунд: по token_count вышло бы 4400 и 14 010.
    expect(requests[0]?.durationMs).toBe(2400)
    expect(requests[4]?.durationMs).toBe(5000)
  })

  /**
   * Приёмка 8.4: повтор после 529 — часть «сколько ждали». Запись `api_error`
   * и `api-request` повторной попытки ложатся посреди ожидания; взятые стартом,
   * они дали бы r3 7000 или 5000 вместо 10 000.
   */
  it('Claude: записи повтора посреди ожидания стартом не бывают', () => {
    const lines = readFileSync(FILES[0]!.path, 'utf8').trimEnd().split('\n')
    const prompt = lines.findIndex((line) => line.includes('"2026-09-01T10:01:00.000Z"'))
    lines.splice(
      prompt + 1,
      0,
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        isSidechain: false,
        sessionId: '0195d1a0-5555-4000-8000-0000000005ed',
        uuid: '0195d1a0-5555-4000-8000-0000000000e1',
        timestamp: '2026-09-01T10:01:03.000Z',
        retryAttempt: 1,
      }),
      JSON.stringify({
        type: 'api-request',
        sessionId: '0195d1a0-5555-4000-8000-0000000005ed',
        id: '0195d1a0-5555-4000-8000-0000000000e2',
        timestamp: '2026-09-01T10:01:05.000Z',
        params: { model: 'claude-opus-5' },
      }),
    )
    const path = join(dir, 'claude-api-error.jsonl')
    writeFileSync(path, lines.join('\n') + '\n')
    expect(parseSessionFile(path).requests.find((r) => r.requestId === 'req_r3')?.durationMs).toBe(
      10000,
    )
  })

  /**
   * Приёмка 8.4: ход, кончившийся без `token_count` (прерванный или с последним
   * `web_search_call`), оставлял начатый ответ, и его старт доставался
   * следующему запросу — через голову нового сообщения человека: здесь 4000
   * вместо 1200, на живой машине до 1 155 минут.
   */
  it('Codex: ход без token_count не тянет старт следующего запроса', () => {
    const lines = readFileSync(FILES[1]!.path, 'utf8').trimEnd().split('\n')
    const prompt = lines.findIndex(
      (line) => line.includes('"2026-09-01T12:01:00.200Z"') && line.includes('user_message'),
    )
    const record = (ts: string, payload: object, type = 'event_msg'): string =>
      JSON.stringify({ timestamp: `2026-09-01T12:01:${ts}Z`, type, payload })
    lines.splice(
      prompt + 1,
      0,
      record('01.000', { type: 'reasoning', summary: [], encrypted_content: 'x' }, 'response_item'),
      record('02.000', { type: 'task_complete', last_agent_message: null }),
      record('03.000', { type: 'user_message', message: 'lorem' }),
    )
    const path = join(dir, 'codex-aborted.jsonl')
    writeFileSync(path, lines.join('\n') + '\n')
    const request = parseRolloutFile(path).requests.find((r) => r.output === 80)
    expect(request?.durationMs).toBe(1200)
  })

  it('Codex: повтор token_count границу не двигает', () => {
    // Повтор лёг в 00:06.000; взятый границей, он дал бы c1 2000 вместо 3000.
    expect(parse('codex-alpha.jsonl').requests[1]?.durationMs).toBe(3000)
  })
})

describe('скорость по моделям', () => {
  it.each(expected.cases)('сходится с ручным расчётом: $name', (value) => {
    ingestSpeedFixture()
    const range = { from: Date.parse(value.from), to: Date.parse(value.to) }
    expect(Object.fromEntries(modelSpeeds(db, range, value.scope))).toEqual(value.speeds)
  })

  /**
   * `Σ output / Σ время` у `claude-opus-5` — 43.1, медиана темпов — 40.0. Хвост
   * длинных ожиданий тянет первое к числу, которого не было ни на одном
   * запросе; на живой машине разрыв доходит до трети.
   */
  it('темп — медиана по запросам, а не Σ/Σ', () => {
    ingestSpeedFixture()
    const opus = modelSpeeds(db, day).get('claude claude-opus-5')
    expect(opus?.tokensPerSecond).toBe(40)
    expect(opus?.tokensPerSecond).not.toBe(43.1)
  })

  it('NULL не попадает в выборку нулём', () => {
    ingestSpeedFixture()
    // В индексе у opus восемь запросов (с восстановленным и r4), измерено шесть.
    const rows = db.all<{ total: number; measured: number }>(
      `SELECT count(*) AS total, count(duration_ms) AS measured FROM requests
       WHERE model = 'claude-opus-5'`,
    )
    expect(rows).toEqual([{ total: 8, measured: 6 }])
    expect(modelSpeeds(db, day).get('claude claude-opus-5')?.requests).toBe(6)
  })

  it('ниже порога скорости нет вовсе — ни нулём, ни медианой из двух', () => {
    ingestSpeedFixture()
    expect(SPEED.minRequests).toBe(5)
    expect(modelSpeeds(db, day).has('claude claude-sonnet-5')).toBe(false)
  })

  /**
   * Маргиналь матрицы получает скорость из той же функции. У клеток проекта её
   * нет в этом этапе — выборка клетки в разы меньше, и порог отсёк бы половину
   * таблицы.
   */
  it('маргиналь матрицы несёт скорость, клетки проекта — нет', () => {
    ingestSpeedFixture()
    const matrix = spendMatrix(db, day)
    const byModel = Object.fromEntries(matrix.models.map((cell) => [cell.model, cell.speed]))
    expect(byModel).toEqual({
      'claude-opus-5': { requests: 6, p50Ms: 5500, p90Ms: 9000, tokensPerSecond: 40 },
      'gpt-5.6-sol': { requests: 6, p50Ms: 4500, p90Ms: 6500, tokensPerSecond: 75 },
      'claude-sonnet-5': undefined,
    })
    for (const row of matrix.rows) for (const cell of row.cells) expect(cell.speed).toBeUndefined()
  })

  it('сужение доезжает до скорости в матрице', () => {
    ingestSpeedFixture()
    const matrix = spendMatrix(db, day, { provider: 'codex' })
    expect(matrix.models.map((cell) => [cell.model, cell.speed?.requests])).toEqual([
      ['gpt-5.6-sol', 6],
    ])
  })
})

describe('миграция 12 — дочитать без сноса', () => {
  /**
   * Снос базы, как в 11, стёр бы сессии пропавших логов, которые правило 19
   * обещало помнить. Миграция добавляет столбец и сбрасывает `offset` — файлы,
   * которые проход найдёт, он перечитает; пропавшие остаются с `NULL`, и это
   * правда: логов нет, мерить нечем. Помеченный пропавшим, но лежащий на диске
   * файл (на копии живого индекса таких 197) тоже перечитывается — иначе
   * совпавшая четвёрка оставила бы его без времени навсегда.
   */
  it('найденные файлы перечитываются, пропавшие остаются в базе без времени', () => {
    const claude = join(dir, 'claude-alpha.jsonl')
    const codex = join(dir, 'codex-alpha.jsonl')
    copyFileSync(FILES[0]!.path, claude)
    copyFileSync(FILES[1]!.path, codex)
    const codexFile: SourceFile = { path: codex, provider: 'codex', kind: 'session' }
    ingestFile(db, { path: claude, provider: 'claude', kind: 'session' })
    ingestFile(db, codexFile)

    // Индекс версии 11: столбца нет (как и двух столбцов миграции 13); Claude-лог
    // пропал с диска, Codex-лог помечен пропавшим, хотя лежит на месте.
    db.run('UPDATE sources SET vanished_at = 1')
    rmSync(claude)
    db.exec('ALTER TABLE requests DROP COLUMN duration_ms')
    db.exec('ALTER TABLE tool_calls DROP COLUMN is_error')
    db.exec('ALTER TABLE sessions DROP COLUMN last_text_head')
    db.run('UPDATE meta SET value = ? WHERE key = ?', '11', 'schema_version')
    db.close()

    const reopened = openDb(join(dir, 'index.sqlite'))
    db = reopened.db
    expect(reopened.rebuilt).toBe(false)
    expect(
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version'),
    ).toEqual({ value: String(SCHEMA_VERSION) })
    expect(db.all<{ offset: number }>('SELECT offset FROM sources')).toEqual([
      { offset: 0 },
      { offset: 0 },
    ])

    // Следующий проход: Codex-лог перечитан, время появилось, пометка снята.
    expect(ingestFile(db, codexFile).parsed).toBe(true)
    expect(
      db
        .all<{ duration_ms: number | null }>(
          `SELECT duration_ms FROM requests JOIN sessions ON sessions.id = requests.session_id
         WHERE sessions.provider = 'codex' ORDER BY seq`,
        )
        .map((row) => row.duration_ms),
    ).toEqual(expectedFor('codex-alpha.jsonl').map((request) => request.durationMs))
    expect(db.get('SELECT vanished_at FROM sources WHERE path = ?', codex)).toEqual({
      vanished_at: null,
    })
    // Сессия пропавшего лога на месте — со всеми запросами, без времени.
    expect(
      db.all<{ n: number; measured: number }>(
        `SELECT count(*) AS n, count(duration_ms) AS measured FROM requests
         JOIN sessions ON sessions.id = requests.session_id WHERE sessions.provider = 'claude'`,
      ),
    ).toEqual([{ n: 11, measured: 0 }])
  })
})

function ingestSpeedFixture(): void {
  for (const file of FILES) ingestFile(db, file)
}
