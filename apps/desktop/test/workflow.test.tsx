import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIG,
  ingestFile,
  openDb,
  type Db,
  type SourceFile,
  type WorkflowConfig,
  type WorkflowReport,
} from '@agentmeter/core'
import { IPC_CALLS, type WorkflowScreen } from '@agentmeter/ipc'
import { buildWorkflowScreen, ERROR_POINTS, projectsOf, toWorkflowScreen } from '../src/main/workflow.ts'
import { WINDOW_TABS, WindowTabs, visibleTabs } from '../src/renderer/components/WindowTabs.tsx'
import { Window } from '../src/renderer/components/Window.tsx'
import { WorkflowTab } from '../src/renderer/components/WorkflowTab.tsx'
import {
  axisTop,
  shareY,
  slotCenters,
  CHART,
} from '../src/renderer/components/WorkflowChart.tsx'
import { sparkSpots } from '../src/renderer/components/WorkflowControls.tsx'
import { quietLabel } from '../src/renderer/components/WorkflowRoles.tsx'
import { setLocale, t } from '../src/renderer/format.ts'
import {
  initialTab,
  requestWorkflow,
  resolveTab,
  workflowSignature,
} from '../src/renderer/window-main.tsx'

/**
 * Экран Workflow (9.5): от `workflowReport` до разметки.
 *
 * Слоёв три. Сборка в main идёт на **настоящем индексе** из `fixtures/workflow/`
 * (12 циклов, расчёт которых сделан руками в его README и лежит в
 * `expected.json`): экран обязан показать ровно эти числа. Разметка проверяется
 * на ответе main, а не на выдуманном объекте. Мелкая арифметика осей — чистыми
 * функциями.
 *
 * Проверки названы по поломке, которую ловят.
 */
setLocale('ru')

const workflowDir = fileURLToPath(new URL('../../../fixtures/workflow/', import.meta.url))
const expected = JSON.parse(readFileSync(join(workflowDir, 'expected.json'), 'utf8')) as {
  cases: Array<{ name: string; report: WorkflowReport }>
}

/** Метки в `expected.json` — ISO; в ответе ядра — миллисекунды. */
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

const oracle = (name: string) =>
  revive(expected.cases.find((value) => value.name === name)!.report)

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-workflow-screen-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed, file.path).toBe(true)
}

/** Весь эталон в индекс: подчинённые раньше корней, как в тесте ядра. */
function ingestFixture(): void {
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

function config(over: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG.workflow),
    enabled: true,
    window: { cycles: 5, sessions: 10 },
    ...over,
  }
}

function screenOf(over: Partial<WorkflowConfig> = {}, project?: string): WorkflowScreen {
  return buildWorkflowScreen(db, config(over), project === undefined ? {} : { project })
}

function render(screen: WorkflowScreen | null, handlers: Partial<Parameters<typeof WorkflowTab>[0]> = {}): string {
  return renderToStaticMarkup(
    <WorkflowTab
      screen={screen}
      onProjectChange={() => undefined}
      onOpenSettings={() => undefined}
      {...handlers}
    />,
  )
}

/** Разметка одной подсказки: от её начала до следующего слота или до конца графика. */
function tipOf(html: string, n: number): string {
  const start = html.indexOf(`data-wf-tip="${n}"`)
  expect(start, `подсказки ${n} нет`).toBeGreaterThan(-1)
  const ends = ['data-wf-slot', 'data-workflow-controls']
    .map((marker) => html.indexOf(marker, start))
    .filter((index) => index > -1)
  return html.slice(start, Math.min(...ends))
}

// ─── main: сборка экрана ──────────────────────────────────────────────────────

describe('main/workflow.ts: экран равен ответу ядра на эталоне', () => {
  beforeEach(ingestFixture)

  /**
   * Ловит главное число, не равное расчёту руками: 7 из 29 против 11 из 35, −7.3 п.п.
   * Дельта едет в п.п. (×100), а не долей — «−0.07» на экране читалось бы как семь
   * сотых процента.
   */
  it('главное число и дельта — расчёт эталона, дельта в п.п.', () => {
    const { rework } = screenOf()
    const want = oracle('all').rework

    expect(rework.size).toBe(5)
    expect(rework.count).toBe(12)
    expect(rework.latest).toMatchObject({ numerator: 7, denominator: 29, unseen: 2 })
    expect(rework.latest!.value).toBeCloseTo(want.latest!.value, 12)
    expect(rework.prev).toMatchObject({ numerator: 11, denominator: 35, unseen: 1 })
    expect(rework.delta!.value).toBeCloseTo(want.delta! * 100, 9)
    expect(rework.delta!.value).toBeCloseTo(-7.29, 2)
    // `≈` у переделки не бывает: восстановленный запрос вызовов не несёт.
    expect(rework.delta!.approximate).toBe(false)
    expect(rework.points.every((point) => !point.approximate)).toBe(true)
  })

  /** Ловит ось, начинающуюся с первого цикла: точка есть только у полного окна. */
  it('точки — только полные окна: ось с цикла № size до count, и у каждой названо исключённое', () => {
    const { rework } = screenOf()

    expect(rework.points.map((point) => point.n)).toEqual([5, 6, 7, 8, 9, 10, 11, 12])
    expect(rework.points.map((point) => point.unseen)).toEqual([1, 1, 1, 2, 1, 1, 2, 2])
    // Из чего сложена точка — для подсказки «окно 8–12 · 24.1% · 7 из 29».
    expect(rework.points[7]).toMatchObject({ numerator: 7, denominator: 29 })
  })

  /**
   * Ловит цвет дельты, зависящий от знака, а не от цели. Без цели — нейтральный;
   * цель 20% ближе к 24.1%, чем к 31.4% — «к цели»; цель 40% дальше — нейтральный.
   */
  it('цвет дельты — направление к цели, без цели нейтральный', () => {
    expect(screenOf().rework.delta!.tone).toBe('neutral')
    expect(screenOf({ target: { rework: 0.2 } }).rework.delta!.tone).toBe('toward')
    expect(screenOf({ target: { rework: 0.4 } }).rework.delta!.tone).toBe('neutral')
    // Перешли цель сверху вниз (31.4% → 24.1% при 30%): по модулю разности это «дальше»,
    // а для потолка — дошли.
    expect(screenOf({ target: { rework: 0.3 } }).rework.delta!.tone).toBe('toward')
    expect(screenOf({ target: { rework: 0.2 } }).rework.target).toBe(0.2)
    expect(screenOf().rework.target).toBeNull()
  })

  /**
   * Ловит «к цели» по модулю разности (приёмка 9.5): рост под целью-потолком
   * (24.1% → 31.4% при цели 40%) ближе к 40 по модулю, но к цели не движется — цель
   * уже достигнута. Отчёт — эталонный, с переставленными окнами.
   */
  it('рост под целью — нейтральный, а не «к цели»', () => {
    const report = oracle('all') as WorkflowReport
    const { latest, prev } = report.rework
    const swapped: WorkflowReport = {
      ...report,
      rework: { ...report.rework, latest: prev, prev: latest, delta: prev!.value - latest!.value },
    }
    const screen = toWorkflowScreen(swapped, config({ target: { rework: 0.4 } }), { projects: [] })
    expect(screen.rework.delta!.value).toBeGreaterThan(0)
    expect(screen.rework.delta!.tone).toBe('neutral')
  })

  /**
   * Ловит фильтр, сузивший картинку, но не окно: в проекте beta три цикла, и при окне
   * 5 полного окна нет вовсе, хотя без фильтра их восемь. Число циклов — проекта.
   */
  it('фильтр проекта пересчитывает окно, а не только рисунок', () => {
    const all = screenOf()
    const beta = screenOf({}, 'beta')
    const alpha = screenOf({}, 'alpha')

    expect(beta.state).toBe('ready')
    expect(beta.rework.count).toBe(oracle('project-beta').rework.count)
    expect(beta.rework.count).toBe(3)
    expect(beta.rework.short).toBe(true)
    expect(beta.rework.points).toEqual([])
    expect(beta.cycles.every((cycle) => cycle.project === 'beta')).toBe(true)
    expect(alpha.rework.count).toBe(6)
    expect(alpha.rework.latest!.value).toBeCloseTo(oracle('project-alpha').rework.latest!.value, 12)
    expect(all.rework.short).toBe(false)
    // Сужение доезжает до роли и ошибок: сессии сабагентов идут за проектом корня.
    expect(beta.roles.cycles).toBe(3)
    expect(beta.errors.count).toBeLessThan(all.errors.count)
  })

  /**
   * Ловит список проектов, схлопнувшийся после выбора: из сегментов «alpha» нельзя
   * вернуться к остальным, если остальных там уже нет.
   */
  it('список проектов — без сужения, по убыванию числа циклов', () => {
    const wide = screenOf().projects
    expect(wide).toEqual([
      { name: 'alpha', cycles: 6 },
      { name: 'beta', cycles: 3 },
      { name: 'gamma', cycles: 3 },
    ])
    expect(screenOf({}, 'beta').projects).toEqual(wide)
    expect(projectsOf([{ project: 'b' }, { project: 'a' }, { project: 'b' }])).toEqual([
      { name: 'b', cycles: 2 },
      { name: 'a', cycles: 1 },
    ])
  })

  /**
   * Ловит два разных пустых экрана под одним словом (правило 15): циклов в индексе
   * нет вовсе, и циклы есть, но не в этом проекте.
   */
  it('фильтр отсёк всё — scope, а нет исполнителей по правилам — none', () => {
    const missing = screenOf({}, 'нет такого')
    expect(missing.state).toBe('scope')
    expect(missing.project).toBe('нет такого')
    // Выход из пустого фильтра виден: проекты остались.
    expect(missing.projects.length).toBe(3)

    const noRules = screenOf({ roles: [] })
    expect(noRules.state).toBe('none')
    expect(noRules.projects).toEqual([])
    expect(noRules.period).toBeNull()
  })

  /**
   * Ловит «окно не набралось», нарисованное как пустое окно без причины: индекс
   * есть, циклов 12, окно 20 — первой точки ещё нет, и главного числа нет.
   */
  it('окно больше числа циклов — short, точек и числа нет', () => {
    const { rework, state } = screenOf({ window: { cycles: 20, sessions: 10 } })

    expect(state).toBe('ready')
    expect(rework.short).toBe(true)
    expect(rework.count).toBe(12)
    expect(rework.size).toBe(20)
    expect(rework.points).toEqual([])
    expect(rework.latest).toBeNull()
  })

  /**
   * Ловит два «дельты нет» под одной надписью: окно до последнего не набралось
   * (нужно 2·size циклов) и окно есть, а точки у него нет. Здесь — первое.
   */
  it('нет дельты: окно до него не набралось — называет, сколько циклов нужно', () => {
    const { rework } = screenOf({ window: { cycles: 7, sessions: 10 } })

    expect(rework.latest).not.toBeNull()
    expect(rework.delta).toBeNull()
    expect(rework.noDelta).toBe('short')
    expect(rework.need).toBe(14)
    expect(rework.count).toBe(12)
  })

  /**
   * Ловит `unseen` окна, посчитанный из точки: при `latest = null` (исключены все)
   * точки нет, а строка про шелл обязана остаться. Здесь окно beta из трёх циклов:
   * считается по циклам, и сходится с числом `executorUnseen`.
   */
  it('исключённые циклы последнего окна считаются по циклам, а не по точке', () => {
    const gamma = screenOf({ window: { cycles: 3, sessions: 10 } }, 'gamma')

    // Все три цикла gamma — с невидимым исполнителем: точки нет, исключены все.
    expect(gamma.rework.latest).toBeNull()
    expect(gamma.rework.unseen).toBe(3)
    expect(gamma.rework.points).toEqual([])
    expect(gamma.cycles.every((cycle) => cycle.unseen)).toBe(true)
  })

  /** Ловит роль без доли и «после» исполнителя нулём вместо прочерка. */
  it('роли: шесть строк, доли к сумме, у исполнителя «после» — null', () => {
    const { roles } = screenOf()
    const want = oracle('all').roles

    expect(roles.rows.map((row) => row.role)).toEqual([
      'main',
      'executor',
      'reviewer',
      'planner',
      'explore',
      'unknown',
    ])
    const total = Object.values(want.spend).reduce((sum, value) => sum + value, 0)
    for (const row of roles.rows) {
      expect(row.spend).toBe(want.spend[row.role])
      expect(row.share).toBeCloseTo(want.spend[row.role] / total, 12)
      expect(row.writes).toBe(want.writes[row.role])
      expect(row.after).toBe(row.role === 'executor' ? null : want.afterByRole[row.role])
    }
    expect(roles.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12)
    expect(roles.unseen).toBe(2)
  })

  /**
   * Ловит блок «после исполнителя», объясняющий не то число: сумма строк обязана
   * равняться числителю главного числа (7), главная и ревьюер стоят всегда, нулевая
   * разведка — одной приглушённой строкой.
   */
  it('«после исполнителя»: сумма равна числителю переделки, нули — одной строкой', () => {
    const { roles, rework } = screenOf()

    expect(roles.after.total).toBe(rework.latest!.numerator)
    expect(roles.after.rows.map((row) => row.role)).toEqual(['main', 'reviewer', 'planner', 'unknown'])
    expect(roles.after.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12)
    expect(roles.after.quiet).toEqual(['explore'])
  })

  /**
   * Ловит главную сессию, пропавшую из «после исполнителя», когда она не правила:
   * ноль в строке — тоже ответ («приёмка в главной сессии ничего не дописала»).
   * Планировщик с нулём, наоборот, своей строки не получает.
   */
  it('главная и ревьюер стоят в «после» и при нуле, остальные роли — только с ненулём', () => {
    const report = structuredClone(oracle('all'))
    report.roles.afterByRole = { main: 0, executor: 0, reviewer: 2, planner: 0, explore: 0, unknown: 1 }

    const { roles } = toWorkflowScreen(report, config(), { projects: [] })
    expect(roles.after.rows.map((row) => [row.role, row.count])).toEqual([
      ['main', 0],
      ['reviewer', 2],
      ['unknown', 1],
    ])
    expect(roles.after.quiet).toEqual(['planner', 'explore'])
    expect(roles.after.total).toBe(3)
  })

  /**
   * Ловит накладные цикла, считанные не той формулой, и бесконечность вместо «—».
   * Формула та же, что у окна: (главная + ревьюер) / исполнитель по расходу цикла.
   */
  it('подсказка: накладные цикла из расхода по ролям, ноль исполнителя — null', () => {
    const { cycles } = screenOf()
    const first = cycles[0]!
    const raw = oracle('all').cycles[0]!

    expect(first.n).toBe(1)
    expect(first.overhead).toBeCloseTo((raw.spend.main + raw.spend.reviewer) / raw.spend.executor, 12)
    expect(first.project).toBe('alpha')
    expect(first.executorWrites).toBe(raw.writes.executor)
    // Отчёт, в котором у цикла нет расхода исполнителя, даёт null, а не Infinity.
    const report = structuredClone(oracle('all'))
    report.cycles[0]!.spend.executor = 0
    const built = toWorkflowScreen(report, config(), { projects: [] })
    expect(built.cycles[0]!.overhead).toBeNull()
  })

  /**
   * Ловит текст головы ответа сабагента в ответе main. Требование контракта: наружу —
   * только вердикт. Проверка по всему JSON ответа, а не по известным полям: новое
   * поле с текстом попалось бы здесь же.
   */
  it('текст головы ответа сабагента в ответ не попадает', () => {
    const heads = db
      .all<{ head: string }>('SELECT last_text_head AS head FROM sessions WHERE last_text_head IS NOT NULL')
      .map((row) => row.head.trim())
      .filter((head) => head.length >= 8)
    expect(heads.length).toBeGreaterThan(5)

    const json = JSON.stringify([screenOf(), screenOf({}, 'alpha')])
    for (const head of heads) expect(json).not.toContain(head)
    // Вердикты при этом считаются: счётчики всех четырёх на месте.
    expect(screenOf().verdicts.counts).toEqual(oracle('all').verdicts.latest!.counts)
  })

  /** Ловит вердикты, посчитанные для экрана заново: доля и «до него» — из ядра. */
  it('вердикты и накладные: окно и дельта как в ответе ядра', () => {
    const screen = screenOf()
    const want = oracle('all')

    expect(screen.verdicts.latest!.value).toBeCloseTo(want.verdicts.latest!.value, 12)
    expect(screen.verdicts.delta!.value).toBeCloseTo(want.verdicts.delta! * 100, 9)
    expect(screen.overhead.latest!.value).toBeCloseTo(want.overhead.latest!.value, 12)
    expect(screen.overhead.delta!.value).toBeCloseTo(want.overhead.delta!, 12)
    // `≈` у накладных — по флагу точки; у дельты — если оценочно любое из двух окон.
    expect(screen.overhead.latest!.approximate).toBe(true)
    expect(screen.overhead.prev!.approximate).toBe(false)
    expect(screen.overhead.delta!.approximate).toBe(true)
    expect(screen.errors.latest!.numerator).toBe(want.errorRate.latest!.numerator)
  })
})

describe('main/workflow.ts: пустой индекс', () => {
  /** Ловит «индекс не собран», показанный как «исполнителей нет»: это разные причины. */
  it('нет ни одного источника — indexing', () => {
    expect(screenOf().state).toBe('indexing')
  })
})

describe('main/workflow.ts: подрезка ряда ошибок', () => {
  function reportWithErrors(points: number): WorkflowReport {
    const report = structuredClone(oracle('all'))
    const series = report.errorRate
    series.count = points + series.size
    series.points = Array.from({ length: points }, (_, index) => ({
      n: series.size + index,
      sessionId: `s${index}`,
      startedAt: 1_700_000_000_000 + index,
      value: index / 1000,
      numerator: index,
      denominator: 1000,
      approximate: false,
    }))
    return report
  }

  /**
   * Ловит ряд из 1 369 точек, уехавший в окно целиком (правило 13 и бриф 9.5): в
   * окно идут последние 48, и последняя из них — настоящая последняя.
   */
  it('в окно уходят последние 48 точек', () => {
    const screen = toWorkflowScreen(reportWithErrors(1369), config(), { projects: [] })

    expect(ERROR_POINTS).toBe(48)
    expect(screen.errors.points).toHaveLength(48)
    expect(screen.errors.points[47]!.n).toBe(10 + 1368)
    expect(screen.errors.points[0]!.n).toBe(10 + 1368 - 47)
    // Короткий ряд не обрезается и не дополняется.
    expect(toWorkflowScreen(reportWithErrors(5), config(), { projects: [] }).errors.points).toHaveLength(5)
  })

  /** Ловит `latest` и `prev`, пересчитанные по подрезанному ряду: окно берёт их как есть. */
  it('latest, prev и дельта приходят из ядра, а не из подрезанного ряда', () => {
    const report = reportWithErrors(100)
    const screen = toWorkflowScreen(report, config(), { projects: [] })

    expect(screen.errors.latest).toMatchObject({
      value: report.errorRate.latest!.value,
      numerator: report.errorRate.latest!.numerator,
    })
    expect(screen.errors.prev!.value).toBe(report.errorRate.prev!.value)
    expect(screen.errors.delta!.value).toBeCloseTo(report.errorRate.delta! * 100, 9)
  })

  /**
   * Ловит второе «дельты нет»: окно до последнего набралось по числу циклов (count ≥
   * 2·size), а точки у него нет (нулевой знаменатель) — причина `noPoint`, не `short`.
   */
  it('нет дельты при набранном окне, но без точки — noPoint', () => {
    const report = structuredClone(oracle('all'))
    report.rework.prev = null
    report.rework.delta = null
    report.rework.count = 12

    const screen = toWorkflowScreen(report, config(), { projects: [] })
    expect(screen.rework.noDelta).toBe('noPoint')
    expect(screen.rework.delta).toBeNull()
  })
})

// ─── разметка вкладки ─────────────────────────────────────────────────────────

describe('WorkflowTab: разметка', () => {
  beforeEach(ingestFixture)

  /** Ловит главное число, подписанное не как «по видимым правкам», и потерянную дельту. */
  it('главное число подписано, дельта в п.п. с минусом, окно названо', () => {
    const html = render(screenOf({ target: { rework: 0.2 } }))

    expect(html).toContain('Переделка · по видимым правкам')
    expect(html).toContain('24,1%')
    expect(html).toContain('−7,3 п.п.')
    expect(html).toContain('последние 5 циклов, по 16 сентября')
    expect(html).toContain('окно до него — 31,4%')
    expect(html).toContain('цель ≤ 20%')
    expect(html).toContain('7 из 29 видимых правок — не исполнителем')
  })

  /**
   * Ловит зелёный цвет у дельты без цели или от цели: «зелёный» здесь значит только
   * «к вашей цели», а `--warn` и `--alarm` на экране не используются вовсе.
   */
  it('дельта зелёная только при движении к цели; тревожных цветов нет', () => {
    const toward = render(screenOf({ target: { rework: 0.2 } }))
    const away = render(screenOf({ target: { rework: 0.4 } }))
    const none = render(screenOf())

    expect(toward).toMatch(/data-workflow-delta="toward"[^>]*color:var\(--ok\)/)
    expect(away).toMatch(/data-workflow-delta="neutral"[^>]*color:var\(--tx2\)/)
    expect(none).toMatch(/data-workflow-delta="neutral"[^>]*color:var\(--tx2\)/)
    for (const html of [toward, away, none]) {
      expect(html).not.toContain('var(--warn)')
      expect(html).not.toContain('var(--alarm)')
    }
  })

  /** Ловит пунктир цели, нарисованный без цели в настройках. */
  it('линия цели — только если цель задана', () => {
    expect(render(screenOf({ target: { rework: 0.2 } }))).toContain('data-workflow-target')
    expect(render(screenOf())).not.toContain('data-workflow-target')
  })

  /**
   * Ловит график не по точкам ядра: на оси ровно восемь окон, а кружков — по числу
   * точек. Окна без точки получили бы кружок «из воздуха».
   */
  it('на графике кружок на каждую точку ответа и подпись исключённых', () => {
    const screen = screenOf()
    const html = render(screen)

    expect(html.split('data-workflow-point=').length - 1).toBe(8)
    // «шеллом K из N» над точками, где исключены циклы (K = 1 или 2, окно 5).
    expect(html).toContain('шеллом 2 из 5')
    expect(html).toContain('шеллом 1 из 5')
    expect(html.match(/data-workflow-unseen="\d+"/g)).toHaveLength(8)
    expect(html).not.toContain('data-workflow-nopoint=')
  })

  /**
   * Ловит окно без точки, выпавшее с оси молча: разрыв по номерам читался бы как
   * потерянные данные. Берём ответ main и убираем из него точку № 7.
   */
  it('окно без точки остаётся на оси подписью «точки нет · шеллом K из K»', () => {
    const screen = screenOf()
    screen.rework.points = screen.rework.points.filter((point) => point.n !== 7)
    const html = render(screen)

    expect(html).toContain('data-workflow-nopoint="7"')
    expect(html).toContain('точки нет')
    expect(html).toContain('шеллом 5 из 5')
    expect(html.split('data-workflow-point=').length - 1).toBe(7)
  })

  /**
   * Ловит строку про шелл, пропавшую из-под главного числа: при двух исключённых
   * циклах из пяти она обязана быть, и называть число словами в правильной форме.
   */
  it('под числом — строка про исполнителя, правившего шеллом', () => {
    const html = render(screenOf())

    expect(html).toContain('data-workflow-unseen')
    expect(html).toContain('по 3 из 5 циклов: в 2 циклах исполнитель правил шеллом — правок не видно')
    // Последнее окно, а не первое: в циклах 8–12 исключены g2 и g3, в 1–5 — один g1.
    expect(screenOf().rework.unseen).toBe(2)
    const one = screenOf({ window: { cycles: 4, sessions: 10 } })
    expect(one.rework.unseen).toBe(one.rework.latest!.unseen)
  })

  it('исключены все: «—» вместо числа, строка про шелл и отметка окна', () => {
    const screen = screenOf({ window: { cycles: 3, sessions: 10 } }, 'gamma')
    const html = render(screen)

    expect(html).toContain('в 3 циклах из 3 исполнитель правил шеллом — правок не видно')
    expect(html).toContain('точки нет: исключены все · окно № 3')
    expect(html).toMatch(/data-workflow-value[^>]*>—</)
    // Подпись окна остаётся: «последние 3 цикла, по <дата>» над тире.
    expect(html).toContain('последние 3 цикла, по ')
  })

  /** Ловит «дельты нет», объяснённую одним словом: у двух причин два текста. */
  it('«дельты нет» называет причину', () => {
    const short = render(screenOf({ window: { cycles: 7, sessions: 10 } }))
    expect(short).toContain('data-workflow-delta="none"')
    expect(short).toContain('окна до него ещё нет: нужно 14 циклов, есть 12')

    const report = structuredClone(oracle('all'))
    report.rework.prev = null
    report.rework.delta = null
    const noPoint = render(toWorkflowScreen(report, config(), { projects: [] }))
    expect(noPoint).toContain('в окне до него исполнитель не виден ни в одном цикле')
  })

  /**
   * Ловит пять пустых состояний, схлопнутых в одно (правило 15). Каждое — своё слово,
   * и «окно не набралось» не рисует график.
   */
  it('пустые состояния говорят разными словами', () => {
    const short = render(screenOf({ window: { cycles: 20, sessions: 10 } }))
    expect(short).toContain('data-workflow-empty="short"')
    expect(short).toContain('Окно не набралось: 12 из 20')
    expect(short).toContain('ещё 8 циклов')
    expect(short).toContain('Размер окна в настройках →')
    expect(short).not.toContain('data-workflow-chart')

    const none = render(screenOf({ roles: [] }))
    expect(none).toContain('Ни одного исполнителя по вашим правилам')
    expect(none).toContain('Правила ролей →')

    const scope = render(screenOf({}, 'нет такого'))
    expect(scope).toContain('В проекте нет такого циклов нет')
    expect(scope).toContain('Все проекты')
    expect(scope).not.toContain('Ни одного исполнителя')

    const loading = render(null)
    expect(loading).toContain('data-workflow-loading')
    expect(loading).not.toContain('Первичное индексирование')

    const empty = render(
      toWorkflowScreen({ ...structuredClone(oracle('all')), emptyIndex: true, cycles: [] }, config(), {
        projects: [],
      }),
    )
    expect(empty).toContain('Первичное индексирование')
  })

  /** Ловит ссылки пустых состояний, ведущие не туда: окно → настройки, фильтр → все проекты. */
  it('ссылки зовут свои обработчики', () => {
    // Ссылка — `<a onClick>`; обработчик берётся из дерева, как в тестах настроек.
    const onOpenSettings = vi.fn()
    const onProjectChange = vi.fn()
    const tree = WorkflowTab({
      screen: screenOf({ roles: [] }),
      onProjectChange,
      onOpenSettings,
    })
    const link = findLink(tree, 'none')
    link.props.onClick!({ preventDefault: () => undefined })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onProjectChange).not.toHaveBeenCalled()

    const scope = findLink(
      WorkflowTab({ screen: screenOf({}, 'нет такого'), onProjectChange, onOpenSettings }),
      'scope',
    )
    scope.props.onClick!({ preventDefault: () => undefined })
    expect(onProjectChange).toHaveBeenCalledWith(undefined)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  /** Ловит фильтр, показывающийся при одном проекте, и сегменты вместо списка при многих. */
  it('фильтр проекта: сегменты, выбранный нажат, при многих проектах — список', () => {
    const html = render(screenOf({}, 'beta'))

    expect(html).toContain('data-workflow-filter="segments"')
    expect(html).toMatch(/aria-pressed="true"[^>]*data-workflow-project="beta"|data-workflow-project="beta"[^>]*aria-pressed="true"/)
    expect(html).toContain('все проекты')

    const many = screenOf()
    many.projects = Array.from({ length: 6 }, (_, index) => ({ name: `p${index}`, cycles: 1 }))
    expect(render(many)).toContain('data-workflow-filter="select"')

    const single = screenOf()
    single.projects = [{ name: 'only', cycles: 12 }]
    expect(render(single)).not.toContain('data-workflow-filter')
  })

  /** Ловит `≈` на ряду, где его не бывает, и пропавший у накладных. */
  it('≈ — только у накладных: число, дельта, пунктир и полые кружки', () => {
    const html = render(screenOf())
    const controls = html.slice(html.indexOf('data-workflow-controls'), html.indexOf('data-workflow-roles'))
    // Главное число и его график: подсказки точек (там накладные цикла с `≈`) — позже.
    const head = html.slice(0, html.indexOf('data-workflow-chart'))

    expect(controls).toMatch(/data-workflow-control="overhead"[\s\S]*?≈×0,81/)
    expect(controls).toContain('≈−0,04')
    expect(controls).toContain('до него ×0,85')
    // Пунктир и полые кружки — у точек с `approximate`.
    expect(controls).toContain('stroke-dasharray:3 3')
    expect(controls).toContain('data-workflow-hollow')
    // Ни главное число, ни дельта переделки, ни ошибки с вердиктами `≈` не несут.
    expect(head).not.toContain('≈')
    const errors = controls.slice(controls.indexOf('data-workflow-control="errors"'))
    expect(errors).not.toContain('≈')
  })

  it('вердикты: счётчики четырёх и полоса', () => {
    const html = render(screenOf())

    expect(html).toContain('Принято 1 · С оговорками 1 · Не принято 1 · Вердикта нет 1')
    expect(html).toContain('среди 3 вынесенных вердиктов')
    for (const verdict of ['accepted', 'notes', 'rejected', 'none']) {
      expect(html).toContain(`data-workflow-verdict="${verdict}"`)
    }
    expect(html).toContain('+33,3 п.п. · до него 33,3%')
  })

  /** Ловит ошибки, поданные без оговорки про единицу окна. */
  it('ошибки: числитель из знаменателя и честная единица окна', () => {
    const html = render(screenOf())

    expect(html).toContain('2 из 36 вызовов с известным статусом')
    expect(html).toContain('Окно — 10 сессий, корни и сабагенты по отдельности')
  })

  /** Ловит шесть строк ролей и прочерк исполнителя, и приглушённую строку нулевых. */
  it('роли: шесть строк, у исполнителя «—», блок «после» с приглушённой строкой', () => {
    const html = render(screenOf())

    for (const role of ['main', 'executor', 'reviewer', 'planner', 'explore', 'unknown']) {
      expect(html).toContain(`data-workflow-role="${role}"`)
    }
    expect(html).toContain('Главная сессия')
    expect(html).toContain('Роль не определена')
    expect(html).toMatch(/data-workflow-role="executor"[\s\S]*?—[\s\S]*?data-workflow-role="reviewer"/)
    expect(html).toContain('data-workflow-after-quiet')
    expect(html).toContain('Разведка')
    expect(html).toContain('в 2 циклах исполнитель не виден: расход учтён, правки — нет')
    expect(quietLabel(['planner', 'explore', 'unknown'])).toBe('Планировщик, разведка, роль не определена')
  })

  /** Ловит подвал без слов про шелл и деньги. */
  it('подвал: шелл и MCP не видны, накладные в токенах', () => {
    const html = render(screenOf())

    expect(html).toContain('Считаются только правки Edit и Write.')
    expect(html).toContain('шеллом идёт большинство правок у всех ролей')
    expect(html).toContain('Накладные — в токенах, а не в деньгах')
    // Грубый счёт пробы в продукт не едет.
    expect(html).not.toContain('32 из 208')
  })
})

describe('WorkflowTab: подсказка точки', () => {
  beforeEach(ingestFixture)

  /**
   * Ловит подсказку не того цикла: точка № n показывает `cycles[n − 1]`. Цикл 8
   * (проект gamma) — невидимый исполнитель, цикл 7 (alpha) — видимый.
   */
  it('у каждого слота своя подсказка: цикл, дата, проект, окно и накладные', () => {
    const html = render(screenOf())

    for (let n = 5; n <= 12; n += 1) expect(html).toContain(`data-wf-tip="${n}"`)
    expect(html).not.toContain('data-wf-tip="4"')
    expect(html).toContain('Цикл 7 · 8 сент · alpha')
    expect(html).toContain('окно 3–7 · 31,4% · 11 из 35')
    expect(html).toContain('Цикл 8 · 10 сент · gamma')
    expect(html).toContain('окно 4–8 · 29,0% · 9 из 31')
  })

  /**
   * Ловит строку «0 правок» у цикла, где исполнитель правил шеллом: без знаменателя
   * такой цикл дал бы 100% — подсказка обязана сказать это, а не показать ноль.
   */
  it('у цикла с невидимым исполнителем — пометка вместо строки записей', () => {
    const screen = screenOf()
    const html = render(screen)
    const tip = (n: number) => tipOf(html, n)

    expect(screen.cycles[7]!.unseen).toBe(true)
    expect(tip(8)).toContain('Исполнитель правил шеллом — правок не видно, в долю окна цикл не входит')
    expect(tip(8)).not.toMatch(/\d+ правок/)
    expect(screen.cycles[6]!.unseen).toBe(false)
    expect(tip(7)).toContain('правок')
    expect(tip(7)).not.toContain('в долю окна цикл не входит')
  })

  /** Ловит `≈` перед накладными цикла без восстановленных запросов и его потерю там, где они есть. */
  it('≈ перед накладными цикла — по флагу inherited, ноль исполнителя — «—»', () => {
    const screen = screenOf()
    const inherited = screen.cycles.filter((cycle) => cycle.overheadApproximate)
    expect(inherited.length).toBeGreaterThan(0)
    screen.cycles[8]!.overhead = null

    const html = render(screen)
    for (const cycle of screen.cycles.filter((value) => value.n >= 5 && value.overhead !== null)) {
      const block = tipOf(html, cycle.n)
      expect(block.includes('≈×'), `цикл ${cycle.n}`).toBe(cycle.overheadApproximate)
    }
    const nine = tipOf(html, 9)
    expect(nine).toContain('накладные цикла')
    expect(nine).toMatch(/накладные цикла<\/span><span[^>]*>—</)
  })

  /** Ловит подсказку, видную всегда: правило показа живёт в стилях, а не в состоянии. */
  it('подсказка спрятана стилями и открывается наведением и фокусом', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../src/renderer/tokens.css', import.meta.url)),
      'utf8',
    )

    expect(css).toMatch(/\[data-wf-tip\][^{]*\{[^}]*visibility:\s*hidden/)
    expect(css).toContain('[data-wf-slot]:hover [data-wf-tip]')
    expect(css).toContain('[data-wf-slot]:focus [data-wf-tip]')
    expect(css).toContain('[data-wf-slot]:hover [data-wf-line]')
    // Линия и подсказка не задают видимость inline: inline сильнее любого селектора.
    const html = render(screenOf())
    expect(html).not.toMatch(/data-wf-tip="\d+" style="[^"]*(visibility|opacity)/)
    expect(html).not.toMatch(/data-wf-line="" style="[^"]*(visibility|opacity)/)
  })
})

// ─── языки ────────────────────────────────────────────────────────────────────

describe('экран Workflow на двух языках', () => {
  afterEach(() => setLocale('ru'))

  /**
   * Ловит строку, оставшуюся русской при английском интерфейсе: проверка кода ловит
   * литералы, а эта — каталог, где перевод мог не быть дописан. Все состояния сразу.
   */
  it('на английском ни одной русской буквы — ни в экране, ни в пустых состояниях', () => {
    ingestFixture()
    setLocale('en')
    const screens = [
      screenOf({ target: { rework: 0.2 } }),
      screenOf({ window: { cycles: 20, sessions: 10 } }),
      screenOf({ roles: [] }),
      screenOf({}, 'beta'),
      screenOf({ window: { cycles: 3, sessions: 10 } }, 'gamma'),
    ]
    screens[3]!.project = 'missing'
    const html = screens.map((screen) => render(screen)).join('\n') + render(null)

    expect(html).not.toMatch(/[А-Яа-яЁё]/)
    expect(html).toContain('Rework · by visible edits')
    expect(html).toContain('Window not full: 12 of 20')
    expect(html).toContain('No executor under your rules')
    expect(html).toContain('−7.3 pp')
  })

  /**
   * Ловит формы числа, взятые не у языка: «в 1 циклах», «по 21 циклов». Русские формы
   * `one/few/many` и английские `one/other` проверены на границах (1, 2, 5, 11, 21).
   */
  it('формы множественного числа в строках экрана', () => {
    setLocale('ru')
    const forms = (key: 'workflow.cyclesCount' | 'workflow.unseenAll' | 'workflow.rolesUnseen') =>
      [1, 2, 5, 11, 21].map((count) => t(key, { count, size: 21 }))

    expect(forms('workflow.cyclesCount')).toEqual(['1 цикл', '2 цикла', '5 циклов', '11 циклов', '21 цикл'])
    expect(forms('workflow.unseenAll')[0]).toBe(
      'в 1 цикле из 21 исполнитель правил шеллом — правок не видно',
    )
    expect(forms('workflow.unseenAll')[1]).toContain('в 2 циклах из 21')
    expect(forms('workflow.unseenAll')[4]).toContain('в 21 цикле из 21')
    expect(forms('workflow.rolesUnseen')[2]).toBe(
      'в 5 циклах исполнитель не виден: расход учтён, правки — нет',
    )

    setLocale('en')
    expect(t('workflow.cyclesCount', { count: 1 })).toBe('1 cycle')
    expect(t('workflow.cyclesCount', { count: 2 })).toBe('2 cycles')
    expect(t('workflow.cyclesCount', { count: 21 })).toBe('21 cycles')
  })
})

// ─── арифметика осей ──────────────────────────────────────────────────────────

describe('график: оси и линии', () => {
  /** Ловит ось, на которую не влезает наибольшая точка или цель. */
  it('верх оси — наименьший круглый, в который всё влезает', () => {
    expect(axisTop(0.346)).toBe(40)
    expect(axisTop(0.4)).toBe(40)
    expect(axisTop(0.41)).toBe(60)
    expect(axisTop(0.05)).toBe(20)
    expect(axisTop(1)).toBe(100)
    expect(axisTop(2)).toBe(100)
  })

  /** Ловит слоты, не совпавшие с макетом: пять слотов — 56, 226, 396, 566, 736. */
  it('слоты ровно по числу полных окон, как в макете', () => {
    expect(slotCenters(5)).toEqual([56, 226, 396, 566, 736])
    expect(slotCenters(1)).toEqual([(CHART.left + CHART.right) / 2])
    expect(slotCenters(0)).toEqual([])
  })

  /** Ловит перевод долей в координаты: 29.4% при оси до 40% — 54.4, как в макете. */
  it('доля → Y: 4 точки на процент при оси до 40%', () => {
    expect(shareY(0.294, 40)).toBeCloseTo(54.4, 6)
    expect(shareY(0.231, 40)).toBeCloseTo(79.6, 6)
    expect(shareY(0, 40)).toBe(CHART.base)
    expect(shareY(0.2, 40)).toBeCloseTo(92, 6)
  })

  /** Ловит линию, сдвигающую соседей на месте пропущенного окна: X — по номеру. */
  it('маленькая линия: X по номеру окна, последняя точка у правого края', () => {
    const dot = (n: number, value: number) => ({
      n,
      startedAt: n,
      value,
      numerator: 0,
      denominator: 1,
      approximate: false,
    })
    const spots = sparkSpots([dot(3, 1), dot(4, 2), dot(7, 4)], 4)

    expect(spots.map((spot) => spot.x)).toEqual([4, 4 + 310 / 4, 314])
    expect(spots[2]!.y).toBe(44 - 36)
    expect(sparkSpots([dot(9, 1)], 1)[0]!.x).toBe(314)
    expect(sparkSpots([dot(1, 0)], 0)[0]!.y).toBe(44)
  })
})

// ─── вкладка в окне ───────────────────────────────────────────────────────────

describe('вкладка Workflow в окне', () => {
  /** Ловит вкладку у тех, кто не гоняет сабагентов, и неверное место при включённой. */
  it('есть только при включённом Workflow, между «Историей» и «Настройками»', () => {
    expect(visibleTabs(false).map((tab) => tab.id)).toEqual(['today', 'breakdown', 'history', 'settings'])
    expect(visibleTabs(true).map((tab) => tab.id)).toEqual([
      'today',
      'breakdown',
      'history',
      'workflow',
      'settings',
    ])
    expect(WINDOW_TABS.map((tab) => tab.id)).toContain('workflow')

    const off = renderToStaticMarkup(<WindowTabs active="today" onChange={() => undefined} />)
    const on = renderToStaticMarkup(<WindowTabs active="today" onChange={() => undefined} workflow />)
    expect(off).not.toContain('Workflow')
    expect(on.indexOf('История')).toBeLessThan(on.indexOf('Workflow'))
    expect(on.indexOf('Workflow')).toBeLessThan(on.indexOf('Настройки'))
  })

  /**
   * Ловит лишние и пропущенные перезапросы экрана (приёмка 9.5): смена состояния
   * агента циклов не меняет, а конец первичной сборки индекса меняет их без единого
   * запроса за сегодня — экран, открытый во время сборки, застрял бы на «индекс не
   * собран». Тики прогресса внутри фазы перезапроса не дают.
   */
  it('экран перезапрашивается по новым запросам и смене фазы сборки, не по агентам', () => {
    type Snap = Parameters<typeof workflowSignature>[0]
    const snap = (total: number, over: Partial<Snap> = {}): Snap =>
      ({ today: { total: { value: total } }, agents: [], ...over }) as unknown as Snap
    const progress = (phase: string, bytesDone: number) =>
      ({ phase, filesDone: 0, filesTotal: 1, bytesDone, bytesTotal: 10 }) as unknown as Snap['indexing']
    const base = workflowSignature(snap(100))

    expect(workflowSignature(snap(200))).not.toBe(base)
    expect(
      workflowSignature(snap(100, { agents: [{ sessionId: 'a', state: 'working' }] as Snap['agents'] })),
    ).toBe(base)
    const parsing = workflowSignature(snap(0, { indexing: progress('parsing', 1) }))
    expect(workflowSignature(snap(0, { indexing: progress('parsing', 9) }))).toBe(parsing)
    expect(workflowSignature(snap(0, { indexing: progress('done', 10) }))).not.toBe(parsing)
  })

  /** Ловит флаг, не доехавший от окна до шапки: вкладка пропала бы у включивших. */
  it('окно передаёт флаг до панели вкладок', () => {
    const snapshot = {
      at: 0,
      agents: [],
      limits: [],
    } as unknown as Parameters<typeof Window>[0]['snapshot']
    const html = (workflow: boolean) =>
      renderToStaticMarkup(
        <Window snapshot={snapshot} activeTab="today" onTabChange={() => undefined} workflow={workflow}>
          {null}
        </Window>,
      )

    expect(html(true)).toContain('Workflow')
    expect(html(false)).not.toContain('Workflow')
  })

  /** Ловит выключенную вкладку, на которой окно остаётся: до неё не дойти из шапки. */
  it('выключили при открытой вкладке — окно уходит на «Сегодня»', () => {
    expect(resolveTab('workflow', false)).toBe('today')
    expect(resolveTab('workflow', true)).toBe('workflow')
    expect(resolveTab('settings', false)).toBe('settings')
    expect(initialTab('?tab=workflow')).toBe('workflow')
  })

  /** Ловит канал, потерянный из контракта, и запрос без фильтра проекта. */
  it('канал workflow:get в контракте, фильтр доезжает до запроса', async () => {
    expect(IPC_CALLS).toContain('workflow:get')
    const get = vi.fn().mockResolvedValue(null)

    await requestWorkflow({ project: 'beta' }, get)
    await requestWorkflow({}, get)

    expect(get).toHaveBeenNthCalledWith(1, { project: 'beta' })
    expect(get).toHaveBeenNthCalledWith(2, {})
  })
})

// ─── helpers для дерева ───────────────────────────────────────────────────────

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'

interface LinkProps {
  children?: ReactNode
  onClick?: (event: { preventDefault: () => void }) => void
  'data-workflow-link'?: string
}

/** Ссылку пустого состояния ищем в дереве: `WorkflowTab` — чистая функция от ответа. */
function findLink(tree: ReactNode, name: string): ReactElement<LinkProps> {
  const walk = (node: ReactNode): Array<ReactElement<LinkProps>> => {
    if (!isValidElement(node)) return []
    const element = node as ReactElement<LinkProps>
    const inner =
      typeof element.type === 'function'
        ? walk((element.type as (props: LinkProps) => ReactNode)(element.props))
        : []
    return [
      element,
      ...Children.toArray(element.props.children).flatMap((child) => walk(child)),
      ...inner,
    ]
  }
  const found = walk(tree).find((element) => element.props['data-workflow-link'] === name)
  expect(found, `ссылка ${name} не найдена`).toBeDefined()
  return found!
}
