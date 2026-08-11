import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ingestFile,
  loadedCategories,
  savings,
  spendSplit,
  type DayRange,
  type SourceFile,
} from '../../src/index.ts'
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

/**
 * Состав статьи поимённо (4.9).
 *
 * Сеется руками по той же причине, что и всё выше: в фикстурах имена
 * обезличены и **повторяются** внутри одного листинга, поэтому объединение по
 * имени на них схлопывает десятки записей в единицы — проверить на таком входе
 * ни охват, ни порядок нельзя.
 */
describe('состав статьи', () => {
  /**
   * Ловит две поломки сразу: охват, посчитанный по вхождениям вместо сессий
   * (скилл, лежавший в двух сессиях, — это два, а не сколько-то ещё), и
   * порядок, отданный алфавиту, — первым обязано стоять то, что лежит чаще, то
   * есть стоит дороже.
   */
  it('имена приезжают с охватом по сессиям и по убыванию охвата', () => {
    seedComposition([
      // `alpha` назван дважды в одной сессии: листинг приезжает и целиком, и
      // дельтой, а в обезличенных фикстурах имена и вовсе повторяются подряд.
      // Считай мы записи вместо сессий — вышло бы «в 3 из 2».
      { id: 'a', blocks: [{ category: 'skills', tokens: 400, names: ['alpha', 'alpha', 'beta'] }] },
      { id: 'b', blocks: [{ category: 'skills', tokens: 400, names: ['alpha', 'gamma'] }] },
    ])

    const skills = loadedCategories(db, allTime).find((row) => row.category === 'skills')!

    expect(skills.sessions).toBe(2)
    expect(skills.unnamed).toBe(0)
    expect(skills.names).toEqual([
      { name: 'alpha', sessions: 2 },
      { name: 'beta', sessions: 1 },
      { name: 'gamma', sessions: 1 },
    ])
  })

  /**
   * Ловит молчание про сессии без состава. День смешивает провайдеров: у Codex
   * память приезжает безымянными блоками, и «в 1 из 2» без этого числа читается
   * как «во второй сессии памяти не было», хотя она там была и стоила денег.
   */
  it('сессия, не назвавшая состав, считается отдельно, а не занижает охват', () => {
    seedComposition([
      { id: 'a', blocks: [{ category: 'memory', tokens: 300, names: ['/proj/CLAUDE.md'] }] },
      { id: 'b', blocks: [{ category: 'memory', tokens: 300 }] },
    ])

    const memory = loadedCategories(db, allTime).find((row) => row.category === 'memory')!

    expect(memory.sessions).toBe(2)
    expect(memory.unnamed).toBe(1)
    expect(memory.names).toEqual([{ name: '/proj/CLAUDE.md', sessions: 1 }])
  })

  /**
   * Ловит состав, собранный без оглядки на статью: одно и то же имя может
   * лежать в разных категориях (скилл и сабагент зовут одинаково сплошь и
   * рядом), и слитый список приписал бы одному другое.
   */
  it('состав не перетекает между статьями', () => {
    seedComposition([
      {
        id: 'a',
        blocks: [
          // Имя нарочно одно на две статьи: скилл и сабагент зовут одинаково
          // сплошь и рядом (`code-review` есть и там, и там). Собери состав по
          // одному имени — и одна из статей осталась бы без него вовсе.
          { category: 'skills', tokens: 300, names: ['code-review'] },
          { category: 'agents', tokens: 300, names: ['code-review'] },
        ],
      },
    ])

    const rows = loadedCategories(db, allTime)

    expect(rows.find((row) => row.category === 'skills')!.names).toEqual([
      { name: 'code-review', sessions: 1 },
    ])
    expect(rows.find((row) => row.category === 'agents')!.names).toEqual([
      { name: 'code-review', sessions: 1 },
    ])
  })
})

describe('savings', () => {
  /**
   * Ловит совет про сервер, которым пользуются, и совет, забывший про режим.
   *
   * Жадный набор — не мелочь: там схемы уехали в системный промпт, цена сервера
   * больше показанной, и насколько, из логов не видно (1.7, разница в 17 раз).
   * Молчание здесь выдало бы нижнюю оценку за всю экономию.
   */
  it('советует только про неиспользованное и считает жадные сессии', () => {
    seed({
      blocks: [
        { category: 'mcpTools', source: 'jira', tokens: 600, items: 62 },
        { category: 'mcpTools', source: 'serena', tokens: 300, items: 23 },
        { category: 'system', tokens: 100, basis: 'residual' },
      ],
      calls: [{ name: 'mcp__serena__find_symbol', server: 'serena' }],
      deferred: false,
    })

    const rows = savings(db, allTime)

    expect(rows.map((row) => row.source)).toEqual(['jira'])
    expect(rows[0]).toMatchObject({ loaded: 62, sessions: 1, unmeasured: 1, projects: ['seed'] })
    expect(rows[0]!.tokens).toBeGreaterThan(0)
  })

  /** Ловит совет, выданный там, где серверов нет вовсе. */
  it('без серверов советовать нечего', () => {
    ingest({ path: join(claudeDir, 'plain.jsonl'), provider: 'claude', kind: 'session' })

    expect(savings(db, allTime)).toEqual([])
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
  /** Был ли в наборе `ToolSearch`. По умолчанию да — цена измерена. */
  deferred?: boolean
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
       VALUES (?, 'claude', ?, '/tmp', 'seed', 1000, 2000, 0, ?, ?, ?)`,
      session.id,
      `/tmp/${session.id}.jsonl`,
      session.id === 'main' ? prefix : 0,
      options.deferred === false ? 0 : 1,
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

/**
 * Несколько сессий со своим составом префикса. Отдельно от `seed`, потому что
 * охват имени измеряется только поперёк сессий: на одной он всегда полный.
 */
function seedComposition(
  sessions: Array<{
    id: string
    blocks: Array<{ category: string; tokens: number; names?: string[] }>
  }>,
): void {
  for (const session of sessions) {
    const prefix = session.blocks.reduce((sum, block) => sum + block.tokens, 0)
    db.run(
      `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                             is_sidechain, prefix_tokens, tools_deferred)
       VALUES (?, 'claude', ?, '/tmp', 'seed', 1000, 2000, 0, ?, 1)`,
      session.id,
      `/tmp/${session.id}.jsonl`,
      prefix,
    )
    db.run(
      `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                             cache_write, cache_read, context_tokens, origin)
       VALUES (?, 0, ?, 1000, 'seed-model', ?, 0, 0, 0, ?, 'log')`,
      session.id,
      `${session.id}#0`,
      prefix,
      prefix,
    )
    session.blocks.forEach((block, idx) => {
      db.run(
        `INSERT INTO prefix_blocks (session_id, idx, category, source, bytes, tokens, basis, items)
         VALUES (?, ?, ?, NULL, 0, ?, 'estimated', ?)`,
        session.id,
        idx,
        block.category,
        block.tokens,
        block.names?.length ?? 1,
      )
      block.names?.forEach((name, ord) => {
        db.run(
          `INSERT INTO prefix_items (session_id, idx, ord, name) VALUES (?, ?, ?, ?)`,
          session.id,
          idx,
          ord,
          name,
        )
      })
    })
  }
}
