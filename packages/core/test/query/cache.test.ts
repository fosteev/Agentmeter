import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CACHE_TTL_1H,
  CACHE_TTL_5M,
  cacheRebuilds,
  ingestFile,
  todayReport,
  type DayRange,
  type SourceFile,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

/**
 * Пересборка кэша (4.4).
 *
 * Фикстуры дают ровно **один** случай из четырёх: в `compact.jsonl` на девятом
 * запросе кэш обвалился (недобор 35 268, записано 37 786) при паузе 6889 с и
 * часовом сроке — то есть пересборка после паузы, корзина ×1–2. Контекст при
 * этом вырос (58 416 против 55 897), так что компакта в файле нет вовсе,
 * несмотря на имя; подробности — в `docs/roadmap/4.4-cache.md`.
 *
 * Значит настоящий компакт, пропажа кэша раньше срока, пятиминутный срок и
 * корзины крупнее первой сеются руками. Проверка на входе без искомого случая
 * зелена при любом правиле, и здесь это правило целиком.
 */

const claudeDir = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const allTime: DayRange = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

/** Разрыв в `compact.jsonl`: записано на девятом запросе, из них уже лежало в кэше. */
const FIXTURE_REBUILD_TOKENS = 37_786
const FIXTURE_REBUILD_REWRITTEN = 35_268

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-cache-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('cacheRebuilds', () => {
  /**
   * Ловит счёт пересборок по размеру записи вместо разрыва цепочки.
   *
   * Кэш дописывается **каждым** запросом — в фикстурах это 130 запросов Claude,
   * — и правило «записал много, значит пересобрал» насчитало бы их десятками.
   * Настоящая пересборка в фикстурах одна.
   */
  it('на фикстурах одна пересборка — та, где цепочка кэша разорвана', () => {
    ingestFixtures()

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.pause.count).toBe(1)
    expect(report.pause.tokens).toBe(FIXTURE_REBUILD_TOKENS)
    expect(report.early.count).toBe(0)
    expect(report.compact.count).toBe(0)
  })

  /**
   * Ловит потерю или задвоение события при разбиении по причинам: сумма четырёх
   * строк обязана совпасть с итогом, иначе таблица противоречит своему же
   * последнему ряду.
   */
  it('четыре причины складываются в итог, до токена', () => {
    ingestFixtures()

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.start.count + report.pause.count + report.early.count + report.compact.count).toBe(
      report.total.count,
    )
    expect(
      report.start.tokens + report.pause.tokens + report.early.tokens + report.compact.tokens,
    ).toBe(report.total.tokens)
    // Стартов ровно столько, сколько сессий Claude с записью кэша: восемь
    // файлов сессий плюс сабагент.
    expect(report.start.count).toBe(9)
  })

  /**
   * Ловит компакт, определённый по кэшу, а не по контексту.
   *
   * Обе сессии роняют чтение кэша одинаково — с 50 000 до нуля. Различает их
   * только контекст: у одной он остался на месте (кэш истёк), у другой упал
   * впятеро (разговор заменён пересказом). Прежнее правило 1.1 назвало бы
   * компактом обе, и на живых логах ошибалось так в 90 случаях из 91.
   */
  it('компакт отличается от пересборки падением контекста, а не кэша', () => {
    seedSession({
      id: 'rebuilt',
      requests: [
        { cacheWrite: 50_000, cacheRead: 0, ttl: CACHE_TTL_1H },
        { cacheWrite: 52_000, cacheRead: 0, ttl: CACHE_TTL_1H, afterMs: 2 * CACHE_TTL_1H },
      ],
    })
    seedSession({
      id: 'squeezed',
      requests: [
        { cacheWrite: 50_000, cacheRead: 0, ttl: CACHE_TTL_1H },
        { cacheWrite: 10_000, cacheRead: 0, ttl: CACHE_TTL_1H, afterMs: 1000, compacted: true },
      ],
    })

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.pause).toEqual({ count: 1, tokens: 52_000 })
    expect(report.compact).toEqual({ count: 1, tokens: 10_000 })
    expect(report.early.count).toBe(0)
  })

  /**
   * Ловит зашитый срок жизни кэша. Пауза в семь минут — это пересборка у
   * сабагента (пятиминутный срок) и «раньше срока» у сессии (часовой). Зашей
   * сюда пять минут — и часовые сессии выдали бы переплату, которой не было;
   * зашей час — и сабагенты не показали бы ту, что была.
   */
  it('пауза сравнивается со сроком из лога, а не с зашитым числом', () => {
    seedSession({
      id: 'hourly',
      requests: [
        { cacheWrite: 30_000, cacheRead: 0, ttl: CACHE_TTL_1H },
        { cacheWrite: 31_000, cacheRead: 0, ttl: CACHE_TTL_1H, afterMs: 7 * 60_000 },
      ],
    })
    seedSession({
      id: 'subagent',
      requests: [
        { cacheWrite: 8_000, cacheRead: 0, ttl: CACHE_TTL_5M },
        { cacheWrite: 9_000, cacheRead: 0, ttl: CACHE_TTL_5M, afterMs: 7 * 60_000 },
      ],
    })

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.pause).toEqual({ count: 1, tokens: 9_000 })
    expect(report.early).toEqual({ count: 1, tokens: 31_000 })
  })

  /**
   * Ловит корзины, посчитанные в минутах вместо кратностей срока. Три паузы —
   * ×1.5, ×3 и ×20 часового срока — обязаны лечь в первую, вторую и четвёртую
   * корзину; пустая третья в список не попадает, чтобы «6 — 12 ч · 0» не
   * читалось как измерение.
   */
  it('корзины пауз — кратности срока, и пустых среди них нет', () => {
    seedSession({
      id: 'paused',
      requests: [
        { cacheWrite: 10_000, cacheRead: 0, ttl: CACHE_TTL_1H },
        { cacheWrite: 11_000, cacheRead: 0, ttl: CACHE_TTL_1H, afterMs: 1.5 * CACHE_TTL_1H },
        { cacheWrite: 12_000, cacheRead: 0, ttl: CACHE_TTL_1H, afterMs: 3 * CACHE_TTL_1H },
        { cacheWrite: 13_000, cacheRead: 0, ttl: CACHE_TTL_1H, afterMs: 20 * CACHE_TTL_1H },
      ],
    })

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.buckets.map((bucket) => [bucket.from, bucket.to, bucket.count])).toEqual([
      [1, 2, 1],
      [2, 6, 1],
      [12, null, 1],
    ])
    expect(report.buckets.map((bucket) => bucket.fromMs)).toEqual([
      CACHE_TTL_1H,
      2 * CACHE_TTL_1H,
      12 * CACHE_TTL_1H,
    ])
    expect(report.worst?.tokens).toBe(13_000)
  })

  /**
   * Ловит срок, взятый у первого попавшегося события.
   *
   * В одном периоде живут сессии (час) и сабагенты (пять минут), а подзаголовок
   * блока называет срок **один**. Первым здесь идёт сабагент — по алфавиту
   * идентификаторов, — и «кэш живёт 5 минут» над таблицей, где восемь строк из
   * девяти часовые, объясняет человеку не то, что он видит.
   */
  it('срок блока берётся у большинства событий, а не у первого', () => {
    seedSession({
      id: 'aaa-subagent',
      requests: [{ cacheWrite: 5_000, cacheRead: 0, ttl: CACHE_TTL_5M }],
    })
    for (const id of ['bbb', 'ccc', 'ddd']) {
      seedSession({ id, requests: [{ cacheWrite: 20_000, cacheRead: 0, ttl: CACHE_TTL_1H }] })
    }

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.start.count).toBe(4)
    expect(report.ttlMs).toBe(CACHE_TTL_1H)
  })

  /**
   * Ловит цепочку, собранную по куску периода. Сессия началась вчера и сегодня
   * только продолжается — стартовой пересборки сегодня не было. Считай мы
   * первый запрос дня стартом, каждое утро приносило бы запись префикса,
   * которой не происходило (та же ловушка, что в 4.1 с `started_at`).
   */
  it('первый запрос дня не считается стартом сессии, начатой раньше', () => {
    seedSession({
      id: 'overnight',
      startedAt: 1_000,
      requests: [
        { cacheWrite: 20_000, cacheRead: 0, ttl: CACHE_TTL_1H },
        { cacheWrite: 500, cacheRead: 20_000, ttl: CACHE_TTL_1H, afterMs: 10_000 },
      ],
    })

    const report = cacheRebuilds(db, { range: { from: 5_000, to: 100_000 } })

    expect(report.total).toEqual({ count: 0, tokens: 0 })
    expect(report.measurable).toBe(true)
  })

  /**
   * Ловит «ноль пересборок» там, где мерить нечем. У Codex `cache_write` равен
   * нулю на всех запросах — провайдер записи в кэш не сообщает вовсе, — и ноль
   * здесь означал бы «посчитали и вышло ноль».
   */
  it('на одном Codex блока нет вовсе, а не блок из нулей', () => {
    ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.measurable).toBe(false)
    expect(report.total).toEqual({ count: 0, tokens: 0 })
  })

  /**
   * Ловит блок, посчитанный от своего знаменателя. Пересборка не добавляет дню
   * ни одного токена: те же токены едут либо чтением, либо записью, а
   * `ctx = input + cacheWrite + cacheRead` от этого не меняется. Значит итог
   * дня обязан совпасть с шапкой — сложи мы пересборки с ним, расход удвоился
   * бы на ровном месте.
   */
  it('итог дня не зависит от пересборок', () => {
    ingestFixtures()

    const report = cacheRebuilds(db, { range: allTime })
    const totals = todayReport(db, allTime).totals

    expect(report.total.tokens).toBeGreaterThan(0)
    expect(totals!.cacheWrite).toBeGreaterThan(report.total.tokens)
    expect(totals!.total).toBe(
      totals!.input + totals!.output + totals!.cacheWrite + totals!.cacheRead,
    )
  })

  it('сужение по провайдеру доезжает', () => {
    ingestFixtures()

    const all = cacheRebuilds(db, { range: allTime })
    const claude = cacheRebuilds(db, { range: allTime, scope: { provider: 'claude' } })
    const codex = cacheRebuilds(db, { range: allTime, scope: { provider: 'codex' } })

    expect(claude.total).toEqual(all.total)
    expect(codex.measurable).toBe(false)
  })

  /**
   * Ловит карточку задачи, показывающую пересборки всего дня. Разрыв в
   * фикстурах один и лежит в `compact.jsonl`; у соседней сессии их ноль, и
   * строка «пересборка кэша» в её карточке обязана отсутствовать, а не
   * повторять чужое число.
   */
  it('у задачи считается её собственная пересборка, а не дневная', () => {
    ingestFixtures()

    const own = cacheRebuilds(db, { sessionId: '21425f5a-e586-413a-ab6a-e9b4ec2c47df' })
    const neighbour = cacheRebuilds(db, { sessionId: 'df072e0f-4296-4606-a960-82e64878f26c' })

    expect(own.pause).toEqual({ count: 1, tokens: FIXTURE_REBUILD_TOKENS })
    expect(own.worst?.rewritten).toBe(FIXTURE_REBUILD_REWRITTEN)
    expect(own.start.count).toBe(1)
    expect(neighbour.pause.count).toBe(0)
  })

  it('рекуррентная запись каждым запросом пересборкой не считается', () => {
    seedSession({
      id: 'healthy',
      requests: [
        { cacheWrite: 20_000, cacheRead: 0, ttl: CACHE_TTL_1H },
        { cacheWrite: 300, cacheRead: 20_000, ttl: CACHE_TTL_1H, afterMs: 30_000 },
        { cacheWrite: 400, cacheRead: 20_300, ttl: CACHE_TTL_1H, afterMs: 30_000 },
      ],
    })

    const report = cacheRebuilds(db, { range: allTime })

    expect(report.start).toEqual({ count: 1, tokens: 20_000 })
    expect(report.pause.count).toBe(0)
    expect(report.early.count).toBe(0)
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
 * Сессия, собранная руками. Фикстуры не содержат ни компакта, ни пропажи кэша
 * раньше срока, ни пятиминутного срока, ни корзин крупнее первой — то есть трёх
 * причин из четырёх и трёх корзин из четырёх там нет вовсе.
 */
function seedSession(options: {
  id: string
  startedAt?: number
  requests: Array<{
    cacheWrite: number
    cacheRead: number
    ttl: number
    /** Сколько прошло с прошлого запроса. У первого не читается. */
    afterMs?: number
    compacted?: boolean
  }>
}): void {
  const startedAt = options.startedAt ?? 1_000_000
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                           is_sidechain, prefix_tokens, tools_deferred)
     VALUES (?, 'claude', ?, '/tmp', 'seed', ?, ?, 0, 0, 0)`,
    options.id,
    `/tmp/${options.id}.jsonl`,
    startedAt,
    startedAt,
  )
  let ts = startedAt
  options.requests.forEach((request, seq) => {
    ts += seq === 0 ? 0 : (request.afterMs ?? 1000)
    db.run(
      `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                             cache_write, cache_read, cache_write_5m, cache_write_1h,
                             context_tokens, compacted, origin)
       VALUES (?, ?, ?, ?, 'seed-model', 0, 0, ?, ?, ?, ?, ?, ?, 'log')`,
      options.id,
      seq,
      `${options.id}#${seq}`,
      ts,
      request.cacheWrite,
      request.cacheRead,
      request.ttl === CACHE_TTL_5M ? request.cacheWrite : null,
      request.ttl === CACHE_TTL_1H ? request.cacheWrite : null,
      request.cacheWrite + request.cacheRead,
      request.compacted === true ? 1 : 0,
    )
  })
}


