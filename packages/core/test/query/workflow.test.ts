/**
 * `workflowReport` (9.3): циклы «план → исполнитель → приёмка», окно, роли.
 *
 * Слоёв три, и они разные по существу.
 *
 * 1. Эталон `fixtures/workflow/`: тринадцать корней, тридцать сабагентов и сессия
 *    Codex, каждый показатель посчитан человеком в `README.md` до кода. Только он
 *    ловит ошибки, которые не видны ни в одном отдельном числе: среднее долей
 *    вместо суммы к сумме, «правки до исполнителя» в числителе, окно `prev` с
 *    пересечением.
 * 2. Именованные проверки на тех же данных — по одной на ловушку. Общее равенство
 *    с `expected.json` краснеет и без них, но «клетка 7/29 против 9/31» ничего не
 *    говорит о причине.
 * 3. Границы на маленьком индексе, собранном руками: то, чего в эталоне нет или
 *    чего нельзя положить в лог (цикл в `parent_session_id`, сирота, пустой проект,
 *    исполнитель без запросов).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  ingestFile,
  verdictOf,
  workflowReport,
  type RequestScope,
  type SourceFile,
  type Verdict,
  type WorkflowConfig,
  type WorkflowCycle,
  type WorkflowReport,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'

const workflowDir = fileURLToPath(new URL('../../../../fixtures/workflow/', import.meta.url))

interface ExpectedSession {
  id: string
  root: string
  agentType: string | null
  provider: 'claude' | 'codex'
  project: string
  startedAt: string
  spend: number
  calls: number
  errors: number
  known: number
  /** Метка `ЧЧ:ММ:СС` запроса → сколько строк `write` в нём; день — из `startedAt`. */
  writes: Record<string, number>
  inherited: boolean
  verdict?: Verdict
}

interface ExpectedCase {
  name: string
  scope: RequestScope
  until?: string
  config: { window: { cycles: number; sessions: number } }
  report: unknown
}

const expected = JSON.parse(readFileSync(join(workflowDir, 'expected.json'), 'utf8')) as {
  sessions: ExpectedSession[]
  cases: ExpectedCase[]
}

/** Метки в `expected.json` — ISO; в ответе — миллисекунды. */
function revive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => revive(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === 'startedAt' || key === 'executorStartedAt') && typeof item === 'string'
          ? Date.parse(item)
          : revive(item),
      ]),
    ) as T
  }
  return value
}

function configOf(window: { cycles: number; sessions: number }): WorkflowConfig {
  return { ...DEFAULT_CONFIG.workflow, window }
}

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-workflow-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed, file.path).toBe(true)
}

/**
 * Весь эталон в индекс. Порядок нарочно обратный алфавитному и подчинённые раньше
 * корней: дерево обязано собираться по `parent_session_id`, а не по порядку чтения.
 */
function ingestWorkflowFixture(): void {
  const names = readdirSync(workflowDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .reverse()
  for (const name of names) {
    const root = join(workflowDir, name)
    if (name.startsWith('codex-')) {
      ingest({ path: root, provider: 'codex', kind: 'session' })
      continue
    }
    const subDir = join(workflowDir, name.replace(/\.jsonl$/, '.subagents'))
    if (existsSync(subDir)) {
      for (const sub of readdirSync(subDir)
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .reverse()) {
        ingest({ path: join(subDir, sub), provider: 'claude', kind: 'subagent', parentPath: root })
      }
    }
    ingest({ path: root, provider: 'claude', kind: 'session' })
  }
}

function run(
  caseName: string,
  override: Partial<{ config: WorkflowConfig; scope: RequestScope; until: number }> = {},
): WorkflowReport {
  const found = expected.cases.find((value) => value.name === caseName)
  if (found === undefined) throw new Error(`нет случая ${caseName}`)
  return workflowReport(db, {
    config: override.config ?? configOf(found.config.window),
    scope: override.scope ?? found.scope,
    ...(override.until !== undefined
      ? { until: override.until }
      : found.until !== undefined
        ? { until: Date.parse(found.until) }
        : {}),
  })
}

function cycle(report: WorkflowReport, id: string): WorkflowCycle {
  const found = report.cycles.find((value) => value.sessionId === id)
  expect(found, `цикла ${id} нет в ответе`).toBeDefined()
  return found!
}

// ─── 1. эталон ───────────────────────────────────────────────────────────────

describe('эталон fixtures/workflow/: ручной расчёт', () => {
  beforeEach(() => ingestWorkflowFixture())

  it.each(expected.cases.map((value) => [value.name, value] as const))(
    'сходится с README.md: %s',
    (_name, value) => {
      const report = run(value.name)
      // Первый случай — равенство целиком: лишнее поле в ответе тоже поломка.
      // Остальные перечисляют только то, ради чего заведены.
      if (value.name === 'all') expect(report).toEqual(revive(value.report))
      else expect(report).toMatchObject(revive(value.report) as object)
    },
  )

  /**
   * Эталон верен только если логи разобраны так, как задумано. Это проверка
   * фикстуры, а не отчёта: если она красная, ошибка в генераторе или парсере, и
   * искать её в `workflowReport` бессмысленно.
   */
  it('логи разобраны так, как задумано: расход, вызовы, записи, роли, вердикты', () => {
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')!.n).toBe(
      expected.sessions.length,
    )
    for (const row of expected.sessions) {
      const session = db.get<{
        project: string
        provider: string
        started_at: number
        parent_session_id: string | null
        agent_type: string | null
        head: string | null
      }>(
        `SELECT project, provider, started_at, parent_session_id, agent_type,
                last_text_head AS head
         FROM sessions WHERE id = ?`,
        row.id,
      )
      expect(session, `сессии ${row.id} нет в индексе`).toBeDefined()
      expect(session!.project, `${row.id}: проект`).toBe(row.project)
      expect(session!.provider, `${row.id}: провайдер`).toBe(row.provider)
      expect(session!.started_at, `${row.id}: старт`).toBe(Date.parse(row.startedAt))
      expect(session!.agent_type, `${row.id}: agentType`).toBe(row.agentType)
      expect(session!.parent_session_id, `${row.id}: родитель`).toBe(
        row.id === row.root ? null : row.root,
      )

      const requests = db.get<{ spend: number; reconstructed: number }>(
        `SELECT sum(input + output + cache_write + cache_read) AS spend,
                count(CASE WHEN origin != 'log' THEN 1 END) AS reconstructed
         FROM requests WHERE session_id = ?`,
        row.id,
      )!
      expect(requests.spend, `${row.id}: расход`).toBe(row.spend)
      expect(requests.reconstructed > 0, `${row.id}: восстановленные`).toBe(row.inherited)

      const calls = db.get<{ calls: number; errors: number; known: number }>(
        `SELECT count(*) AS calls, count(CASE WHEN is_error = 1 THEN 1 END) AS errors,
                count(is_error) AS known
         FROM tool_calls WHERE session_id = ?`,
        row.id,
      )!
      expect(calls, `${row.id}: вызовы`).toEqual({
        calls: row.calls,
        errors: row.errors,
        known: row.known,
      })

      const day = row.startedAt.slice(0, 10)
      const written = db
        .all<{ ts: number }>(
          `SELECT requests.ts AS ts
           FROM tool_files
           JOIN requests ON requests.session_id = tool_files.session_id
                        AND requests.seq = tool_files.seq
           WHERE tool_files.session_id = ? AND tool_files.action = 'write'
           ORDER BY requests.ts`,
          row.id,
        )
        .map((value) => value.ts)
      const wanted = Object.entries(row.writes)
        .flatMap(([time, count]) =>
          Array.from({ length: count }, () => Date.parse(`${day}T${time}.000Z`)),
        )
        .sort((a, b) => a - b)
      expect(written, `${row.id}: записи файлов`).toEqual(wanted)

      if (row.verdict !== undefined)
        expect(
          verdictOf(session!.head, DEFAULT_CONFIG.workflow.verdicts),
          `${row.id}: вердикт`,
        ).toBe(row.verdict)
    }
  })
})

// ─── 2. ловушки поимённо ─────────────────────────────────────────────────────

describe('workflowReport: ловушки эталона по именам', () => {
  beforeEach(() => ingestWorkflowFixture())

  it('циклы — по времени начала корня, а не по имени', () => {
    const report = run('all')

    expect(report.cycles.map((value) => value.sessionId)).toEqual([
      'a1',
      'b1',
      'a2',
      'g1',
      'a3',
      'b2',
      'a4',
      'g2',
      'b3',
      'a5',
      'g3',
      'a6',
    ])
  })

  it('окно считает суммы, а не усредняет доли', () => {
    const point = run('all').rework.points.find((value) => value.n === 5)!

    // Доли циклов 1…5: 1/3, 1/6, 1/2, (нет), 2/5. Среднее — 0.35, сумма к сумме —
    // 10/32 = 0.3125.
    expect(point.numerator).toBe(10)
    expect(point.denominator).toBe(32)
    expect(point.value).toBe(0.3125)
  })

  it('накладные — тоже сумма к сумме: короткий исполнитель не раздувает окно', () => {
    const point = run('all').overhead.points.find((value) => value.n === 10)!

    // Цикл 10: накладные 5800 на 500 токенов исполнителя, доля цикла 11.6. Среднее
    // долей окна было бы около 2.8; сумма к сумме — 20300/26000.
    expect(point).toMatchObject({ numerator: 20300, denominator: 26000 })
    expect(point.value).toBe(20300 / 26000)
  })

  it('правки главной сессии до старта исполнителя не входят в after', () => {
    const a1 = cycle(run('all'), 'a1')

    // Корень записал четыре файла: два в 10:00 (промт, roadmap) и два в 10:50.
    // Исполнитель стартовал в 10:15.
    expect(a1.writes.main).toBe(4)
    expect(a1.writesAfter.main).toBe(2)
    expect(a1.executorStartedAt).toBe(Date.parse('2026-09-01T10:15:00.000Z'))
  })

  it('запись ровно на метке старта исполнителя входит в after (>=)', () => {
    const a3 = cycle(run('all'), 'a3')

    expect(a3.executorStartedAt).toBe(Date.parse('2026-09-07T10:10:00.000Z'))
    expect(a3.writes.main).toBe(2)
    expect(a3.writesAfter.main).toBe(1)
  })

  it('граница — старт первого исполнителя: запись между двумя стартами входит в after', () => {
    const b2 = cycle(run('all'), 'b2')

    expect(b2.executorStartedAt).toBe(Date.parse('2026-09-08T10:10:00.000Z'))
    expect(b2.writes.executor).toBe(8)
    expect(b2.writesAfter.main).toBe(1)
    expect(b2.writesAfter.reviewer).toBe(1)
    // Исполнитель после себя не считается никогда.
    expect(b2.writesAfter.executor).toBe(0)
  })

  it('планировщик, правящий после старта исполнителя, виден отдельно', () => {
    const b3 = cycle(run('all'), 'b3')

    expect(b3.writes.planner).toBe(2)
    expect(b3.writesAfter.planner).toBe(2)
    expect(b3.writesAfter.main).toBe(0)
    expect(b3.writes.main).toBe(3)
  })

  it('чтение — не запись, повторная правка одного файла — две записи', () => {
    const a1 = cycle(run('all'), 'a1')

    // У `a1-exec` четыре строки `write` на три разных файла и два чтения.
    expect(a1.writes.executor).toBe(4)
  })

  it('unknown не становится исполнителем: его записи — after, а корень от него не цикл', () => {
    const report = run('all')

    const a3 = cycle(report, 'a3')
    expect(a3.writes.executor).toBe(6)
    expect(a3.writes.unknown).toBe(3)
    expect(a3.writesAfter.unknown).toBe(3)
    expect(a3.spend.unknown).toBe(2000)
    // `b0`: general-purpose правит файлы, исполнителя нет — цикла нет.
    expect(report.cycles.map((value) => value.sessionId)).not.toContain('b0')
  })

  it('ролей ровно шесть, и unknown есть в ответе, даже когда в нём ноль', () => {
    const report = run('all')

    expect(Object.keys(report.roles.spend).sort()).toEqual([
      'executor',
      'explore',
      'main',
      'planner',
      'reviewer',
      'unknown',
    ])
    expect(Object.keys(report.cycles[0]!.spend)).toEqual(Object.keys(report.roles.spend))
    expect(run('project-beta').roles.spend.unknown).toBe(0)
    expect(Object.keys(run('project-beta').roles.spend)).toContain('unknown')
  })

  it('ошибки делятся на вызовы с известным статусом: Codex и вызов без результата не разбавляют', () => {
    const report = run('all')

    // Окно 35…44 захватывает `x1` — пять вызовов Codex без статуса.
    expect(report.errorRate.latest).toMatchObject({ numerator: 2, denominator: 36 })
    // `a3-gp` и `b3-exec` — по одному вызову без результата.
    expect(cycle(report, 'a3').toolCalls).toBe(17)
    expect(cycle(report, 'a3').toolErrorsKnown).toBe(16)
    expect(cycle(report, 'b3').toolErrorsKnown).toBe(23)
  })

  it('окно ошибок — по сессиям в порядке времени, а не по именам', () => {
    const report = run('all')

    expect(report.errorRate.points.at(0)).toMatchObject({ n: 10, sessionId: 'a2-rev' })
    expect(report.errorRate.latest).toMatchObject({ n: 44, sessionId: 'a6-gp' })
  })

  it('prev — окно без пересечения: кончается на size раньше, а не на единицу', () => {
    const report = run('all')

    expect(report.rework.latest!.n).toBe(12)
    expect(report.rework.prev!.n).toBe(7)
    expect(report.overhead.prev!.n).toBe(7)
    expect(report.verdicts.prev!.n).toBe(7)
    expect(report.errorRate.prev!.n).toBe(34)
    expect(report.rework.delta).toBe(report.rework.latest!.value - report.rework.prev!.value)
  })

  it('нет окна перед последним — нет дельты, а циклы пересчитаны', () => {
    const report = run('until')

    expect(report.rework.count).toBe(8)
    expect(report.rework.latest!.n).toBe(8)
    expect(report.rework.prev).toBeNull()
    expect(report.rework.delta).toBeNull()
  })

  it('окно не набралось — точек нет, а число циклов сообщается', () => {
    const report = run('project-beta')

    expect(report.cycles).toHaveLength(3)
    expect(report.rework).toMatchObject({ size: 5, count: 3, points: [], latest: null })
    expect(report.overhead.points).toEqual([])
  })

  it('точка с нулевым знаменателем пропускается, а не становится нулём', () => {
    const gamma = run('project-gamma')

    // Три цикла без единой записи через Edit/Write: знаменатель 0.
    expect(gamma.rework).toMatchObject({
      count: 3,
      points: [],
      latest: null,
      prev: null,
      delta: null,
    })
    // Накладные у тех же циклов считаются, значит дело именно в знаменателе.
    expect(gamma.overhead.points).toHaveLength(1)

    // Окно ошибок из одной сессии Codex: пять вызовов, известных нет.
    const codex = run('provider-codex')
    expect(codex.errorRate).toMatchObject({ count: 1, points: [], latest: null })
  })

  it('законный нуль не пропадает: вердиктов «не принят» в окне нет, точка есть', () => {
    const point = run('all').verdicts.points.find((value) => value.n === 8)!

    expect(point).toMatchObject({ numerator: 0, denominator: 3, value: 0 })
  })

  it('сабагент идёт за корнем, а не за своим каталогом', () => {
    const alpha = run('project-alpha')
    const beta = run('project-beta')

    // `a2-rev` запущен из каталога beta, но под корнем alpha; `b2-exec2` — наоборот.
    expect(alpha.errorRate.count).toBe(21)
    expect(beta.errorRate.count).toBe(14)
    expect(alpha.errorRate.latest).toMatchObject({ n: 21, sessionId: 'a6-gp' })
    expect(beta.errorRate.latest).toMatchObject({ n: 14, sessionId: 'b3-rev' })
    expect(alpha.cycles.map((value) => value.sessionId)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'a6',
    ])
    expect(cycle(alpha, 'a2').spend.reviewer).toBe(3000)
    expect(cycle(beta, 'b2').spend.executor).toBe(7000)
  })

  it('сумма ошибок проекта — по деревьям его корней: чужой каталог сабагента ничего не меняет', () => {
    // Окно во все сессии проекта: одна точка, и это сумма всего, что в проекте есть.
    // Счётчики сессий совпадают по обе стороны (21 = 21, 14 = 14), так что отличить
    // `a2-rev` от `b2-exec2` может только знаменатель: 4 известных против 8.
    const alpha = run('all', {
      config: configOf({ cycles: 5, sessions: 21 }),
      scope: { project: 'alpha' },
    })
    const beta = run('all', {
      config: configOf({ cycles: 5, sessions: 14 }),
      scope: { project: 'beta' },
    })

    expect(alpha.errorRate.points).toHaveLength(1)
    expect(alpha.errorRate.latest).toMatchObject({ numerator: 5, denominator: 88 })
    expect(beta.errorRate.points).toHaveLength(1)
    expect(beta.errorRate.latest).toMatchObject({ numerator: 6, denominator: 67 })
  })

  it('сужение до пустоты отличается от пустого индекса', () => {
    const none = run('project-missing')
    const codex = run('provider-codex')

    expect(none).toMatchObject({ emptyIndex: false, emptyScope: true, cycles: [] })
    expect(codex).toMatchObject({ emptyIndex: false, emptyScope: true, cycles: [] })
    expect(run('all').emptyScope).toBe(false)
  })

  it('провайдер сужает и окно ошибок: Codex уходит вместе с x1', () => {
    const claude = run('provider-claude')

    expect(claude.errorRate.count).toBe(43)
    expect(claude.cycles).toHaveLength(12)
  })

  it('роли последнего окна — только его циклы', () => {
    const roles = run('all').roles

    expect(roles.cycles).toBe(5)
    expect(roles.spend.executor).toBe(19500)
    expect(roles.afterByRole).toEqual({
      main: 3,
      executor: 0,
      reviewer: 1,
      planner: 2,
      explore: 0,
      unknown: 1,
    })
  })

  it('вердикт — у ревьюеров и по первой строке', () => {
    const report = run('all')

    expect(cycle(report, 'b2').verdicts).toEqual(['accepted'])
    expect(cycle(report, 'a2').verdicts).toEqual(['rejected'])
    expect(cycle(report, 'g1').verdicts).toEqual(['none'])
    expect(cycle(report, 'a5').verdicts).toEqual(['none'])
    // Слова «с оговорками» у исполнителя b1 и «Принят» у general-purpose a3 —
    // не вердикты цикла.
    expect(cycle(report, 'b1').verdicts).toEqual(['notes'])
    expect(cycle(report, 'a3').verdicts).toEqual([])
    expect(cycle(report, 'a6').verdicts).toEqual([])
  })

  it('восстановленные запросы помечают цикл и накладные окна', () => {
    const report = run('all')

    expect(cycle(report, 'b3').inherited).toBe(true)
    expect(cycle(report, 'b3').spend.executor).toBe(10000)
    expect(report.cycles.filter((value) => value.inherited)).toHaveLength(1)
    expect(report.overhead.points.map((value) => value.approximate)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ])
    // Восстановленный запрос вызовов не несёт: записи, ошибки и вердикты — не `≈`.
    for (const series of [report.rework, report.errorRate, report.verdicts])
      expect(series.points.every((value) => !value.approximate)).toBe(true)
  })

  it('роли берутся из конфига: правило пользователя делает general-purpose исполнителем', () => {
    const config: WorkflowConfig = {
      ...configOf({ cycles: 5, sessions: 10 }),
      roles: [{ match: 'general-purpose', role: 'executor' }, ...DEFAULT_CONFIG.workflow.roles],
    }
    const report = run('all', { config })

    // `b0` становится циклом, и `a3-gp` с `a6-gp` — исполнителями.
    expect(report.cycles).toHaveLength(13)
    expect(report.cycles.map((value) => value.sessionId)).toContain('b0')
    expect(cycle(report, 'a3').writes.unknown).toBe(0)
    expect(cycle(report, 'a3').writes.executor).toBe(9)
  })

  it('порядок чтения файлов ответ не меняет', () => {
    const first = run('all')
    db.close()
    db = openDb(join(dir, 'second.sqlite')).db
    const names = readdirSync(workflowDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
    for (const name of names) {
      const root = join(workflowDir, name)
      if (name.startsWith('codex-')) ingest({ path: root, provider: 'codex', kind: 'session' })
      else {
        ingest({ path: root, provider: 'claude', kind: 'session' })
        const subDir = join(workflowDir, name.replace(/\.jsonl$/, '.subagents'))
        if (existsSync(subDir))
          for (const sub of readdirSync(subDir)
            .filter((file) => file.endsWith('.jsonl'))
            .sort())
            ingest({
              path: join(subDir, sub),
              provider: 'claude',
              kind: 'subagent',
              parentPath: root,
            })
      }
    }

    expect(run('all')).toEqual(first)
  })
})

// ─── 3. границы на индексе, собранном руками ─────────────────────────────────

interface SeedSession {
  id: string
  start: number
  parent?: string
  type?: string
  project?: string
  provider?: 'claude' | 'codex'
  head?: string | null
}

let sourceCounter = 0

function seedSession(session: SeedSession): void {
  sourceCounter += 1
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                           parent_session_id, agent_type, is_sidechain, prefix_tokens,
                           tools_deferred, last_text_head)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    session.id,
    session.provider ?? 'claude',
    `/seed/${sourceCounter}-${session.id}.jsonl`,
    `/work/${session.project ?? 'p'}`,
    session.project ?? 'p',
    session.start,
    session.start,
    session.parent ?? null,
    session.type ?? null,
    session.parent === undefined ? 0 : 1,
    session.head ?? null,
  )
}

/** Запрос с расходом `total` и, по желанию, вызовами: `E` — запись, `R` — чтение. */
function seedRequest(
  sessionId: string,
  seq: number,
  ts: number,
  total: number,
  calls: Array<{ kind: 'E' | 'R' | 'B'; error?: 0 | 1 | null }> = [],
  origin = 'log',
): void {
  db.run(
    `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output, cache_write,
                           cache_read, context_tokens, origin)
     VALUES (?, ?, ?, ?, 'm', ?, 0, 0, 0, 0, ?)`,
    sessionId,
    seq,
    `r${sessionId}${seq}`,
    ts,
    total,
    origin,
  )
  calls.forEach((call, idx) => {
    db.run(
      `INSERT INTO tool_calls (session_id, seq, idx, name, kind, is_error) VALUES (?, ?, ?, ?, 'x', ?)`,
      sessionId,
      seq,
      idx,
      call.kind === 'E' ? 'Edit' : call.kind === 'R' ? 'Read' : 'Bash',
      call.error ?? null,
    )
    if (call.kind === 'E' || call.kind === 'R')
      db.run(
        `INSERT INTO tool_files (session_id, seq, idx, path, action) VALUES (?, ?, ?, ?, ?)`,
        sessionId,
        seq,
        idx,
        `src/${idx}.ts`,
        call.kind === 'E' ? 'write' : 'read',
      )
  })
}

function seedSource(): void {
  db.run(
    `INSERT INTO sources (path, provider, session_id, inode, size, mtime, offset, parsed_at)
     VALUES ('/seed/source', 'claude', NULL, 1, 1, 1, 1, 1)`,
  )
}

const MIN = 60_000
const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const window1 = configOf({ cycles: 1, sessions: 1 })

/**
 * Цикл из корня и исполнителя: корень стартует в `at`, исполнитель — через
 * 10 минут и пишет `executorWrites` файлов.
 */
function seedCycle(
  id: string,
  at: number,
  options: { project?: string; executorWrites?: number } = {},
): void {
  const project = options.project ?? 'p'
  seedSession({ id, start: at, project })
  seedRequest(id, 0, at, 100)
  seedSession({
    id: `${id}-x`,
    start: at + 10 * MIN,
    parent: id,
    type: 'exec-sonnet-high',
    project,
  })
  seedRequest(
    `${id}-x`,
    0,
    at + 10 * MIN,
    1000,
    Array.from({ length: options.executorWrites ?? 0 }, () => ({
      kind: 'E' as const,
      error: 0 as const,
    })),
  )
}

describe('workflowReport: границы', () => {
  it('пустой индекс — отдельное состояние, ничего не падает', () => {
    const report = workflowReport(db, { config: DEFAULT_CONFIG.workflow })

    expect(report.emptyIndex).toBe(true)
    expect(report.emptyScope).toBe(false)
    expect(report.cycles).toEqual([])
    expect(report.rework).toEqual({
      size: 10,
      count: 0,
      points: [],
      latest: null,
      prev: null,
      delta: null,
    })
    expect(report.errorRate).toMatchObject({ size: 20, count: 0, points: [] })
    expect(report.roles.cycles).toBe(0)
    expect(Object.values(report.roles.spend).every((value) => value === 0)).toBe(true)
  })

  it('индекс есть, циклов нет вовсе: не emptyIndex и не emptyScope', () => {
    seedSource()
    seedSession({ id: 'solo', start: T0 })
    seedRequest('solo', 0, T0, 100, [{ kind: 'E', error: 0 }])

    const report = workflowReport(db, { config: DEFAULT_CONFIG.workflow })

    expect(report).toMatchObject({ emptyIndex: false, emptyScope: false, cycles: [] })
    expect(report.errorRate.count).toBe(1)
  })

  it('пустая строка — законный ключ проекта, а не «без сужения»', () => {
    seedSource()
    seedCycle('named', T0, { project: 'x', executorWrites: 1 })
    seedCycle('blank', T0 + 60 * MIN, { project: '', executorWrites: 2 })

    const blank = workflowReport(db, { config: window1, scope: { project: '' } })
    const all = workflowReport(db, { config: window1 })

    expect(blank.cycles.map((value) => value.sessionId)).toEqual(['blank'])
    expect(blank.errorRate.count).toBe(2)
    expect(all.cycles.map((value) => value.sessionId)).toEqual(['named', 'blank'])
    // И наоборот: пустой проект не просачивается в чужое сужение.
    const named = workflowReport(db, { config: window1, scope: { project: 'x' } })
    expect(named.cycles.map((value) => value.sessionId)).toEqual(['named'])
    expect(named.errorRate.count).toBe(2)
  })

  it('until — строго раньше: цикл, начатый ровно в until, не входит', () => {
    seedSource()
    seedCycle('first', T0, { executorWrites: 1 })
    seedCycle('second', T0 + 60 * MIN, { executorWrites: 1 })

    const before = workflowReport(db, { config: window1, until: T0 + 60 * MIN })
    const after = workflowReport(db, { config: window1, until: T0 + 60 * MIN + 1 })

    expect(before.cycles.map((value) => value.sessionId)).toEqual(['first'])
    expect(after.cycles.map((value) => value.sessionId)).toEqual(['first', 'second'])
    expect(before.errorRate.count).toBe(2)
    expect(after.errorRate.count).toBe(4)
  })

  it('глубина дерева не ограничена: исполнитель внука тоже делает корень циклом', () => {
    seedSource()
    seedSession({ id: 'root', start: T0 })
    seedRequest('root', 0, T0, 100)
    seedSession({ id: 'child', start: T0 + MIN, parent: 'root', type: 'plan-opus' })
    seedRequest('child', 0, T0 + MIN, 100)
    seedSession({ id: 'grand', start: T0 + 2 * MIN, parent: 'child', type: 'exec-sonnet-high' })
    seedRequest('grand', 0, T0 + 2 * MIN, 700, [{ kind: 'E', error: 0 }])

    const report = workflowReport(db, { config: window1 })

    expect(report.cycles).toHaveLength(1)
    expect(report.cycles[0]!.spend).toMatchObject({ main: 100, planner: 100, executor: 700 })
    expect(report.cycles[0]!.writes.executor).toBe(1)
  })

  it('цикл в parent_session_id не зацикливает обход', () => {
    seedSource()
    seedCycle('real', T0, { executorWrites: 1 })
    // Две сессии ссылаются друг на друга и до корня не доходят; третья ссылается на
    // корень и на себя же через него.
    seedSession({ id: 'loop-a', start: T0 + 5 * MIN, parent: 'loop-b', type: 'exec-sonnet-high' })
    seedSession({ id: 'loop-b', start: T0 + 6 * MIN, parent: 'loop-a', type: 'exec-sonnet-high' })
    db.run(`UPDATE sessions SET parent_session_id = 'real-x' WHERE id = 'real'`)

    const report = workflowReport(db, { config: window1 })

    expect(report.cycles.map((value) => value.sessionId)).toContain('real')
    expect(report.errorRate.count).toBe(4)
  })

  it('сирота — своя единица окна ошибок с собственным проектом, но не цикл', () => {
    seedSource()
    seedCycle('c', T0, { project: 'x', executorWrites: 1 })
    seedSession({
      id: 'orphan',
      start: T0 + 30 * MIN,
      parent: 'gone',
      type: 'exec-sonnet-high',
      project: 'y',
    })
    seedRequest('orphan', 0, T0 + 30 * MIN, 100, [{ kind: 'B', error: 1 }])

    const all = workflowReport(db, { config: window1 })
    const y = workflowReport(db, { config: window1, scope: { project: 'y' } })
    const x = workflowReport(db, { config: window1, scope: { project: 'x' } })

    expect(all.cycles.map((value) => value.sessionId)).toEqual(['c'])
    expect(all.errorRate.count).toBe(3)
    expect(y.errorRate.count).toBe(1)
    expect(y.errorRate.latest).toMatchObject({ numerator: 1, denominator: 1 })
    expect(x.errorRate.count).toBe(2)
  })

  it('исполнитель без запросов не задаёт границу: after остаётся нулём', () => {
    seedSource()
    seedSession({ id: 'r', start: T0 })
    seedRequest('r', 0, T0 + 20 * MIN, 100, [{ kind: 'E', error: 0 }])
    seedSession({ id: 'idle', start: 0, parent: 'r', type: 'exec-sonnet-high' })

    const report = workflowReport(db, { config: window1 })

    expect(report.cycles).toHaveLength(1)
    expect(report.cycles[0]!.executorStartedAt).toBeNull()
    expect(report.cycles[0]!.writes.main).toBe(1)
    expect(report.cycles[0]!.writesAfter.main).toBe(0)
  })

  it('исполнитель без видимых записей исключён из переделки и назван числом', () => {
    // Приёмка 9.3: на живых логах 4 цикла из 7 — исполнитель пишет шеллом, а
    // главная сессия правит Edit-ом. Без исключения такой цикл даёт 3 / 3 = 100%.
    seedSource()
    seedCycle('seen', T0, { executorWrites: 3 })
    seedRequest('seen', 1, T0 + 30 * MIN, 100, [{ kind: 'E', error: 0 }])
    seedCycle('shell', T0 + 60 * MIN)
    seedRequest('shell-x', 1, T0 + 75 * MIN, 100, [{ kind: 'B', error: 0 }])
    seedRequest('shell', 1, T0 + 90 * MIN, 100, [
      { kind: 'E', error: 0 },
      { kind: 'E', error: 0 },
      { kind: 'E', error: 0 },
    ])

    const report = workflowReport(db, { config: configOf({ cycles: 2, sessions: 1 }) })

    expect(report.cycles.map((value) => value.executorUnseen)).toEqual([false, true])
    expect(report.cycles[1]!.writesAfter.main).toBe(3)
    expect(report.rework.latest).toMatchObject({ n: 2, numerator: 1, denominator: 4, unseen: 1 })
    expect(report.roles).toMatchObject({ cycles: 2, unseen: 1 })
    // Разбивка объясняет главное число: after по ролям в сумме — его числитель.
    expect(report.roles.afterByRole.main).toBe(1)
    expect(report.roles.writes.executor).toBe(3)
    // Расход невидимого исполнителя остаётся в накладных и в ролях.
    expect(report.overhead.latest).toMatchObject({ denominator: 2100 })
    expect(report.roles.spend.executor).toBe(2100)
  })

  it('все циклы окна без видимого исполнителя — точки нет, а не 100%', () => {
    seedSource()
    seedCycle('shell', T0)
    seedRequest('shell', 1, T0 + 30 * MIN, 100, [{ kind: 'E', error: 0 }])

    const report = workflowReport(db, { config: window1 })

    expect(report.cycles[0]!.executorUnseen).toBe(true)
    expect(report.rework.points).toEqual([])
    expect(report.rework.latest).toBeNull()
  })

  it('ничья по started_at решается по id, а не по порядку вставки', () => {
    seedSource()
    seedCycle('zz', T0, { executorWrites: 1 })
    seedCycle('aa', T0, { executorWrites: 1 })

    const report = workflowReport(db, { config: window1 })

    expect(report.cycles.map((value) => value.sessionId)).toEqual(['aa', 'zz'])
  })

  it('последнее окно с нулевым знаменателем — latest пуст, а не позапрошлое окно', () => {
    seedSource()
    seedCycle('w1', T0, { executorWrites: 2 })
    seedCycle('w2', T0 + 60 * MIN, { executorWrites: 1 })
    seedCycle('n1', T0 + 120 * MIN)
    seedCycle('n2', T0 + 180 * MIN)

    const report = workflowReport(db, { config: configOf({ cycles: 2, sessions: 1 }) })

    expect(report.rework.count).toBe(4)
    expect(report.rework.points.map((value) => value.n)).toEqual([2, 3])
    expect(report.rework.latest).toBeNull()
    expect(report.rework.prev).toMatchObject({ n: 2, numerator: 0, denominator: 3 })
    expect(report.rework.delta).toBeNull()
  })

  it('вердикты цикла идут в порядке старта ревьюеров, а не идентификаторов', () => {
    seedSource()
    seedCycle('c', T0, { executorWrites: 1 })
    // Идентификаторы нарочно против времени: поздний ревьюер называется `a-late`.
    seedSession({
      id: 'a-late',
      start: T0 + 40 * MIN,
      parent: 'c',
      type: 'review-opus',
      head: '**Не принят.**',
    })
    seedSession({
      id: 'z-early',
      start: T0 + 30 * MIN,
      parent: 'c',
      type: 'review-opus',
      head: '**Принят.**',
    })

    const report = workflowReport(db, { config: window1 })

    expect(report.cycles[0]!.verdicts).toEqual(['accepted', 'rejected'])
  })

  it('enabled конфига агрегат не читает: вкладка и уведомления — забота экрана', () => {
    seedSource()
    seedCycle('c', T0, { executorWrites: 1 })

    const report = workflowReport(db, { config: { ...window1, enabled: false } })

    expect(report.cycles).toHaveLength(1)
  })
})
