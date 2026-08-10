import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, spendSplit, todayReport, type DayRange, type SourceFile } from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

/**
 * Постоянное против разового (4.1) на настоящем индексе из фикстур.
 *
 * Числа ниже посчитаны умножением, а не выводом реализации: у каждой сессии
 * фикстур префикс `P` и число запросов `R` известны из разбора, ни на одном
 * запросе контекст не падает ниже префикса, значит постоянное равно `P × R`.
 *
 *   compact  41124×23 =  945 852     sidechain    21373×11 = 235 103
 *   images   40199×12 =  482 388     version-mid  36223× 9 = 326 007
 *   mcp      37057× 9 =  333 513     version-old  23475×19 = 446 025
 *   parallel 37288× 5 =  186 440     сабагент     12091×27 = 326 457
 *   plain    40693×11 =  447 623     codex        22457× 8 = 179 656
 *                                                 итого   3 909 064
 *
 * Ровно поэтому ограничение сверху (`min`) проверяется на посеянной руками
 * сессии, а не на фикстурах: на них оно не срабатывает ни разу и проверка была
 * бы зелена при любом правиле.
 */

const claudeDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }
const RECURRING = 3_909_064
const TOTAL = 5_750_569

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-split-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('spendSplit', () => {
  /**
   * Ловит второй знаменатель. Итог дня складывается из четырёх видов токенов, а
   * разложение — из контекста и ответа; это одна и та же сумма, записанная
   * иначе, и разойтись ей нельзя ни на токен: иначе доля под шапкой считалась
   * бы от числа, которого в шапке нет.
   */
  it('итог разложения — тот же итог, что в шапке дня', () => {
    ingestFixtures()

    const split = spendSplit(db, allTime)

    expect(split.total).toBe(TOTAL)
    expect(split.total).toBe(todayReport(db, allTime).totals?.total)
  })

  it('постоянное равно префиксу, умноженному на число запросов сессии', () => {
    ingestFixtures()

    const split = spendSplit(db, allTime)

    expect(split.recurring).toBe(RECURRING)
    expect(split.marginal).toBe(TOTAL - RECURRING)
    expect(split.recurring + split.marginal).toBe(split.total)
  })

  /**
   * Ловит дележ, потерявший или добавивший токены на округлении: у каждой
   * сессии свой множитель, и наивное `блок × recurring / P` по каждому блоку
   * отдельно расходится с целым на единицы токенов — молча.
   */
  it('сумма категорий равна постоянному до токена', () => {
    ingestFixtures()

    const split = spendSplit(db, allTime)
    const sum = split.categories.reduce((total, row) => total + row.tokens, 0)

    expect(sum).toBe(split.recurring)
    expect(split.categories.length).toBeGreaterThan(4)
  })

  /**
   * Ловит потерю различия «остаток против оценки». Остаток — это системный
   * промпт и схемы вшитых тулов, выключить его нельзя; смешай его с
   * посчитанными блоками — и 4.3 посоветует отключить самого агента.
   */
  it('остаток и оценка различимы, и остаток — самая дорогая статья', () => {
    ingestFixtures()

    const split = spendSplit(db, allTime)
    const residual = split.categories.filter((row) => row.basis === 'residual')
    const estimated = split.categories.filter((row) => row.basis === 'estimated')

    expect(residual.map((row) => row.category).sort()).toEqual(['system', 'toolSchemas'])
    expect(estimated.some((row) => row.category === 'skills')).toBe(true)
    expect(residual.reduce((sum, row) => sum + row.tokens, 0)).toBeGreaterThan(
      estimated.reduce((sum, row) => sum + row.tokens, 0),
    )
  })

  /**
   * Ловит сужение, доехавшее только до итога. Разрез по провайдеру обязан
   * складываться в тот же постоянный расход, что без сужения, — иначе на экране
   * окажутся два разных ответа на один вопрос, каждый настоящий по себе (3.2).
   */
  it('сужение по провайдеру и по проекту складывается в общий итог', () => {
    ingestFixtures()

    const split = spendSplit(db, allTime)
    const claude = spendSplit(db, allTime, { provider: 'claude' })
    const codex = spendSplit(db, allTime, { provider: 'codex' })

    expect(claude.recurring + codex.recurring).toBe(split.recurring)
    expect(claude.total + codex.total).toBe(split.total)
    const projects = todayReport(db, allTime).projects.map(
      (row) => spendSplit(db, allTime, { project: row.key }).recurring,
    )
    expect(projects.reduce((sum, value) => sum + value, 0)).toBe(split.recurring)
  })

  /**
   * Ловит `P × R` вместо `Σ min(P, ctx)`.
   *
   * Компакт роняет контекст ниже префикса, и без ограничения сверху разовое
   * уходит в минус — то есть экран показывает отрицательный расход. На живых
   * логах таких запросов 1 из 28 824, в фикстурах нет ни одного, поэтому
   * сессия посеяна руками: без неё проверка зелена при любом правиле.
   */
  it('запрос после компакта платит за контекст, а не за весь префикс', () => {
    seedSession({ id: 'compacted', prefix: 1000, contexts: [1000, 200], output: 10 })

    const split = spendSplit(db, allTime)

    expect(split.recurring).toBe(1200)
    expect(split.total).toBe(1220)
    expect(split.marginal).toBe(20)
    expect(split.categories.reduce((sum, row) => sum + row.tokens, 0)).toBe(1200)
  })

  /**
   * Ловит дележ округлением вместо наибольшей дробной части.
   *
   * На фикстурах он неотличим от правильного: постоянное там равно `P × R`, то
   * есть кратно префиксу, и любая доля делится нацело — проверка «сумма равна
   * целому» зелена при любом правиле. Разница появляется ровно там, где
   * сработал `min`: 1200 на весах 333/333/334 даёт 400+399+401, а округление —
   * 400+400+401, то есть на токен больше целого.
   */
  it('дележ категорий не теряет и не добавляет токенов на некратном остатке', () => {
    seedSession({
      id: 'thirds',
      prefix: 1000,
      contexts: [1000, 200],
      output: 0,
      blocks: [
        { category: 'skills', tokens: 333 },
        { category: 'agents', tokens: 333 },
        { category: 'system', tokens: 334, basis: 'residual' },
      ],
    })

    const split = spendSplit(db, allTime)

    expect(split.recurring).toBe(1200)
    expect(split.categories.reduce((sum, row) => sum + row.tokens, 0)).toBe(1200)
    expect(
      Object.fromEntries(split.categories.map((row) => [row.category, row.tokens])),
    ).toEqual({ system: 401, skills: 400, agents: 399 })
  })

  /**
   * Ловит «первая запись» = число сессий периода. Сессия, начавшаяся вчера,
   * заплатила за запись префикса вчера, а сегодня только перечитывает его;
   * посчитай запись обеим — и день, в котором продолжили вчерашнюю задачу,
   * покажет расход, которого не было.
   */
  it('за первую запись префикса платит только тот день, в котором сессия началась', () => {
    seedSession({
      id: 'yesterday',
      prefix: 500,
      contexts: [500, 500],
      output: 0,
      startedAt: 10,
      requestTs: [2000, 3000],
    })
    seedSession({ id: 'today', prefix: 700, contexts: [700], output: 0, startedAt: 5000 })

    const split = spendSplit(db, { from: 1000, to: 9000 })

    expect(split.recurring).toBe(1700)
    expect(split.firstRead).toBe(700)
    expect(split.sessions).toBe(1)
  })

  it('на пустом периоде разложения нет вовсе, а не разложение из нулей', () => {
    ingestFixtures()

    const split = spendSplit(db, { from: 0, to: 1 })

    expect(split.total).toBe(0)
    expect(split.recurring).toBe(0)
    expect(split.marginal).toBe(0)
    expect(split.categories).toEqual([])
  })
})

function ingestFixtures(): void {
  for (const name of [
    'compact',
    'images',
    'mcp',
    'parallel',
    'plain',
    'sidechain',
    'version-mid',
    'version-old',
  ]) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({
    path: join(claudeDir, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
    provider: 'claude',
    kind: 'subagent',
    parentPath: join(claudeDir, '92cc27dc-193d-4c2c-aef1-843d7d41aeab.jsonl'),
  })
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
}

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

/**
 * Сессия, собранная руками: фикстуры не содержат ни падения контекста ниже
 * префикса, ни переползания через границу периода, а проверка на входе без
 * искомого случая зелена при любом правиле.
 */
function seedSession(options: {
  id: string
  prefix: number
  contexts: number[]
  output: number
  startedAt?: number
  /** Когда шли запросы, если не подряд от начала сессии. */
  requestTs?: number[]
  /** Раскладка префикса; по умолчанию один остаток на весь префикс. */
  blocks?: Array<{ category: string; tokens: number; basis?: 'estimated' | 'residual' }>
}): void {
  const startedAt = options.startedAt ?? 1000
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                           is_sidechain, prefix_tokens, tools_deferred)
     VALUES (?, 'claude', ?, '/tmp', 'seed', ?, ?, 0, ?, 0)`,
    options.id,
    `/tmp/${options.id}.jsonl`,
    startedAt,
    startedAt + 1000,
    options.prefix,
  )
  const blocks = options.blocks ?? [
    { category: 'system', tokens: options.prefix, basis: 'residual' as const },
  ]
  blocks.forEach((block, idx) => {
    db.run(
      `INSERT INTO prefix_blocks (session_id, idx, category, source, bytes, tokens, basis)
       VALUES (?, ?, ?, NULL, 0, ?, ?)`,
      options.id,
      idx,
      block.category,
      block.tokens,
      block.basis ?? 'estimated',
    )
  })
  options.contexts.forEach((context, seq) => {
    db.run(
      `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                             cache_write, cache_read, context_tokens, origin)
       VALUES (?, ?, ?, ?, 'seed-model', ?, ?, 0, 0, ?, 'log')`,
      options.id,
      seq,
      `${options.id}#${seq}`,
      options.requestTs?.[seq] ?? startedAt + seq,
      context,
      options.output,
      context,
    )
  })
}
