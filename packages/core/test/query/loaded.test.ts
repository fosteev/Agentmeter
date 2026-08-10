import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, loadedCategories, spendSplit, type DayRange, type SourceFile } from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

/**
 * Что загружено против того, что использовано (4.2).
 *
 * Почти всё здесь сеется руками, и это не лень: листинги в фикстурах
 * обезличены — записи `- имя: описание` в них превратились в сплошной lorem
 * ipsum, поэтому скиллов и сабагентов там **ноль**, а имён `mcp__*` нет вовсе.
 * Проверка «сервер, который не звали, виден нулём вызовов» на таком входе
 * зелена при любом правиле. Фикстуры остаются там, где им есть что сказать, —
 * в тождестве с расходом.
 */

const claudeDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-loaded-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('loadedCategories', () => {
  /**
   * Ловит колонку, разошедшуюся с полосой над ней: строки левой колонки — это
   * то же постоянное, разложенное по статьям, и их сумма обязана сойтись с ним
   * до токена.
   */
  it('сумма статей равна постоянному расходу периода', () => {
    ingest({ path: join(claudeDir, 'plain.jsonl'), provider: 'claude', kind: 'session' })
    ingest({ path: join(claudeDir, 'mcp.jsonl'), provider: 'claude', kind: 'session' })

    const rows = loadedCategories(db, allTime)
    const sum = rows.reduce((total, row) => total + row.tokens, 0)

    expect(sum).toBe(spendSplit(db, allTime).recurring)
    expect(rows.length).toBeGreaterThan(2)
  })

  /**
   * Ловит ноль вместо «измерить нечем».
   *
   * «Ноль вызовов» — повод посоветовать выключить, и поставить его там, где мы
   * просто не умеем считать, значит посоветовать наугад. У остатка и у первой
   * реплики использованного не существует в принципе.
   */
  it('там, где считать нечего, стоит null, а не ноль', () => {
    ingest({ path: join(claudeDir, 'plain.jsonl'), provider: 'claude', kind: 'session' })

    const rows = loadedCategories(db, allTime)
    const residual = rows.find((row) => row.basis === 'residual')!
    const userTurn = rows.find((row) => row.category === 'userTurn')!

    expect(residual.loaded).toBeNull()
    expect(residual.used).toBeNull()
    expect(userTurn.used).toBeNull()
  })

  /**
   * Ловит главное число экрана: сервер, чьи описания грузились в каждую сессию,
   * а звали его ноль раз. Именно с него начинается совет 4.3, и ошибка здесь —
   * это совет выключить то, чем пользуются.
   */
  it('сервер без вызовов виден нулём, а вызванный — числом своих тулов', () => {
    seed({
      blocks: [
        { category: 'mcpTools', source: 'jira', tokens: 600, items: 62 },
        { category: 'mcpTools', source: 'serena', tokens: 300, items: 23 },
        { category: 'system', tokens: 100, basis: 'residual' },
      ],
      calls: [
        { name: 'mcp__serena__find_symbol', server: 'serena' },
        { name: 'mcp__serena__find_symbol', server: 'serena' },
        { name: 'mcp__serena__read_file', server: 'serena' },
      ],
    })

    const mcp = loadedCategories(db, allTime).find((row) => row.category === 'mcpTools')!
    const jira = mcp.sources.find((source) => source.source === 'jira')!
    const serena = mcp.sources.find((source) => source.source === 'serena')!

    expect(mcp.loaded).toBe(2)
    expect(mcp.used).toBe(1)
    expect(jira).toMatchObject({ loaded: 62, used: 0, calls: 0 })
    expect(serena).toMatchObject({ loaded: 23, used: 2, calls: 3 })
    expect(jira.tokens).toBeGreaterThan(serena.tokens)
  })

  /**
   * Ловит «использовано», посчитанное по вызовам вместо разных имён: скилл,
   * позванный трижды, — это один использованный скилл, а не три.
   */
  it('скиллы и сабагенты считаются по разным именам, а не по вызовам', () => {
    seed({
      blocks: [
        { category: 'skills', tokens: 400, items: 9 },
        { category: 'agents', tokens: 200, items: 5 },
        { category: 'system', tokens: 400, basis: 'residual' },
      ],
      skills: ['figma', 'figma', 'pilot-jira'],
      agentTypes: ['Explore'],
    })

    const rows = loadedCategories(db, allTime)

    expect(rows.find((row) => row.category === 'skills')).toMatchObject({ loaded: 9, used: 2 })
    expect(rows.find((row) => row.category === 'agents')).toMatchObject({ loaded: 5, used: 1 })
  })
})

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

/**
 * Сессия с заданной раскладкой префикса и вызовами. Руками, потому что в
 * фикстурах ни листингов с записями, ни серверов MCP нет вовсе.
 */
function seed(options: {
  blocks: Array<{
    category: string
    source?: string
    tokens: number
    items?: number
    basis?: 'estimated' | 'residual'
  }>
  calls?: Array<{ name: string; server: string }>
  skills?: string[]
  agentTypes?: string[]
}): void {
  const prefix = options.blocks.reduce((sum, block) => sum + block.tokens, 0)
  const sessions = [
    { id: 'main', agentType: null as string | null },
    ...(options.agentTypes ?? []).map((agentType, index) => ({ id: `child-${index}`, agentType })),
  ]
  for (const session of sessions) {
    db.run(
      `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                             is_sidechain, prefix_tokens, tools_deferred, agent_type)
       VALUES (?, 'claude', ?, '/tmp', 'seed', 1000, 2000, 0, ?, 1, ?)`,
      session.id,
      `/tmp/${session.id}.jsonl`,
      session.id === 'main' ? prefix : 0,
      session.agentType,
    )
  }
  options.blocks.forEach((block, idx) => {
    db.run(
      `INSERT INTO prefix_blocks (session_id, idx, category, source, bytes, tokens, basis, items)
       VALUES ('main', ?, ?, ?, 0, ?, ?, ?)`,
      idx,
      block.category,
      block.source ?? null,
      block.tokens,
      block.basis ?? 'estimated',
      block.items ?? 1,
    )
  })
  const skills = options.skills ?? []
  for (const session of sessions) {
    const own = session.id === 'main' ? Math.max(1, skills.length) : 1
    for (let seq = 0; seq < own; seq += 1) {
      db.run(
        `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                               cache_write, cache_read, context_tokens, origin, skill)
         VALUES (?, ?, ?, ?, 'seed-model', ?, 0, 0, 0, ?, 'log', ?)`,
        session.id,
        seq,
        `${session.id}#${seq}`,
        1000 + seq,
        prefix,
        prefix,
        session.id === 'main' ? (skills[seq] ?? null) : null,
      )
    }
  }
  options.calls?.forEach((call, idx) => {
    db.run(
      `INSERT INTO tool_calls (session_id, seq, idx, name, kind, server, marginal_tokens, marginal_basis)
       VALUES ('main', 0, ?, ?, 'mcp', ?, 0, 'measured')`,
      idx,
      call.name,
      call.server,
    )
  })
}
