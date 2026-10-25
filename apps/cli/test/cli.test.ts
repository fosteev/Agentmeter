import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ingestFile,
  openDb,
  t,
  type MatrixCell,
  type SourceFile,
  type SpendMatrix,
} from '@agentmeter/core'
import { run } from '../src/main.ts'

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
const matrixDir = fileURLToPath(new URL('../../../fixtures/matrix/', import.meta.url))
const speedDir = fileURLToPath(new URL('../../../fixtures/speed/', import.meta.url))

let dir: string
let indexPath: string
let configPath: string
let stdout: string[]
let stderr: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-cli-'))
  indexPath = join(dir, 'index.sqlite')
  // Язык пиним явно: с 3.8 по умолчанию берётся системный, а снапшот вывода
  // проверяет структуру русского текста. Без этого проверка ловила бы локаль
  // машины, на которой её запустили, — то есть ничего.
  configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ ui: { locale: 'ru' } }))
  seedIndex()
  stdout = []
  stderr = []
  vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)))
  vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('agentmeter CLI', () => {
  it('today --json пинит ручные итоги фикстур числами, не снапшотом', () => {
    const code = execute('today', '--day', '2026-08-09', '--days', '60', '--json')
    const report = JSON.parse(stdout[0]!) as {
      totals: Record<string, number>
      sessions: number
      approximate: boolean
    }

    expect(code).toBe(0)
    expect(report.totals).toEqual({
      input: 60_064,
      output: 55_349,
      cacheWrite: 338_669,
      cacheRead: 5_296_487,
      total: 5_750_569,
      requests: 134,
    })
    expect(report.sessions).toBe(10)
    expect(report.approximate).toBe(true)
  })

  it('today текстом держит структуру вывода отдельно от чисел', () => {
    expect(execute('today', '--day', '2026-08-09', '--days', '60')).toBe(0)

    expect(maskNumbers(stdout[0]!)).toMatchInlineSnapshot(`
      "# июня # г. · ≈# токенов · # запроса · # задач
      input # · output # · cache write # · cache read #

      Провайдеры
      Имя     Токены  Запросы
      ──────  ──────  ───────
      claude    #      #
      codex   #        #

      Модели
      Имя              Токены  Запросы
      ───────────────  ──────  ───────
      claude-opus-#-#    #       #
      claude-opus-#        #       #
      claude-fable-#   #       #
      claude-opus-#-#  #       #
      gpt-#          #        #

      Проекты
      Имя               Токены  Запросы
      ────────────────  ──────  ───────
      d                   #       #
      b                   #       #
      a                   #       #
      e                 #       #
      lorem ipsum dolo  #        #
      f                 #        #

      По часам
      Час    Токены  Запросы
      ─────  ──────  ───────
      #:#  #        #
      #:#  #        #
      #:#    #        #
      #:#    #       #
      #:#  #       #
      #:#    #       #
      #:#  #        #

      Куда ушло сегодня
      Имя                         Токены  Доля
      ──────────────────────────  ──────  ────
      постоянный                    #   #%
      разовый                       #   #%
        system (остаток)            #   #%
        skills                    #    #%
        userTurn                  #    #%
        toolSchemas (остаток)     #    #%
        agents                     #    #%
        system                     #    #%
        deferredTools              #    #%
        memory                      #    #%
        mcpInstructions · lorem     #    #%"
    `)
  })

  it('tasks сворачивает сабагента в родителя в JSON', () => {
    expect(execute('tasks', '--day', '2026-07-10', '--json')).toBe(0)
    const result = JSON.parse(stdout[0]!) as {
      rows: Array<{ sessionId: string; children: Array<{ sessionId: string }> }>
    }

    expect(result.rows.some((row) => row.sessionId === 'a6bf337b0067775dd')).toBe(false)
    expect(
      result.rows
        .find((row) => row.sessionId === '92cc27dc-193d-4c2c-aef1-843d7d41aeab')
        ?.children.map((child) => child.sessionId),
    ).toEqual(['a6bf337b0067775dd'])
  })

  it('breakdown --json не сливает basis в одну цифру', () => {
    expect(execute('breakdown', '--day', '2026-07-28', '--by', 'tool', '--json')).toBe(0)
    const result = JSON.parse(stdout[0]!) as {
      tool: Array<{ calls: Record<string, number>; tokens: Record<string, number> }>
    }

    expect(result.tool.length).toBeGreaterThan(0)
    expect(
      result.tool.every(
        (row) => Object.keys(row.tokens).sort().join(',') === 'measured,split,unknown',
      ),
    ).toBe(true)
  })

  it('limits сохраняет неизвестный процент как null в JSON', () => {
    addCurrentClaudeRequest()

    expect(execute('limits', '--json')).toBe(0)
    const result = JSON.parse(stdout[0]!) as {
      windows: Array<{
        provider: string
        usedPercent: number | null
        unavailableReason: string | null
      }>
    }
    const claude = result.windows.filter((window) => window.provider === 'claude')

    expect(claude).toHaveLength(2)
    expect(result.windows.some((window) => window.provider === 'codex')).toBe(true)
    expect(claude.every((window) => window.usedPercent === null)).toBe(true)
    expect(claude.every((window) => window.unavailableReason?.includes('1.9'))).toBe(true)
  })

  it('пустой индекс не сериализует нулевые итоги', () => {
    const emptyPath = join(dir, 'empty.sqlite')

    expect(
      run(['today', '--no-ingest', '--index', emptyPath, '--config', configPath, '--json']),
    ).toBe(0)
    const result = JSON.parse(stdout[0]!) as { emptyIndex: boolean; totals: unknown }
    expect(result.emptyIndex).toBe(true)
    expect(result.totals).toBeNull()
  })

  it('doctor возвращает 1 только при parser_error', () => {
    expect(execute('doctor', '--json')).toBe(0)
    const { db } = openDb(indexPath)
    db.run(
      `INSERT INTO diagnostics (source_path, kind, detail, count, cli_version, seen_at)
       VALUES ('future', 'unknown_record_type', 'future', 3, '2.0', 0),
              ('bad', 'parser_error', 'boom', 1, '2.0', 0)`,
    )
    db.close()
    stdout.length = 0

    expect(execute('doctor', '--json')).toBe(1)
    expect((JSON.parse(stdout[0]!) as { parserErrors: number }).parserErrors).toBe(1)
  })

  /**
   * Единственная проверка, которая запускает CLI как программу.
   *
   * Все остальные зовут `run()` напрямую и точку входа не трогают вовсе — а
   * ломается именно она. Сравнение шло со строкой `file://${process.argv[1]}`,
   * и на Windows оно ложно всегда: слева `file:///G:/…`, справа `file://G:\…`.
   * `run()` не звался, команда печатала пустоту и выходила нулём — то есть CLI
   * не работал целиком, при полностью зелёном наборе тестов.
   *
   * Проверяется `breakdown` из списка флагов, а не переведённая строка: `--help`
   * печатается до чтения конфига, на языке системы, и ловить им локаль машины
   * значит не проверять ничего.
   */
  it('запускается как программа, а не только через run()', () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--experimental-strip-types', main, '--help'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('breakdown')
  })

  it('неверные аргументы возвращают 2', () => {
    expect(execute('today', '--provider', 'other')).toBe(2)
    expect(stderr[0]).toContain('claude или codex')
  })
})

/**
 * Разрез «проект × модель» и скорость в CLI (8.3).
 *
 * Эталоны — `fixtures/matrix/` и `fixtures/speed/`: числа посчитаны руками в их
 * README до кода и сверяются здесь как числа, а не как снапшот вывода. Окна
 * выбраны с запасом на часовой пояс машины: записи матрицы лежат 20 августа,
 * скорости — 1 сентября, и ни один из периодов не цепляет чужой.
 */
describe('breakdown --by project-model / --by model (8.3)', () => {
  const matrixPeriod = ['--day', '2026-08-28', '--days', '20'] // 9–28 августа: только матрица
  const speedPeriod = ['--day', '2026-09-03', '--days', '3'] // 1–3 сентября: только скорость

  beforeEach(() => {
    indexPath = join(dir, 'matrix.sqlite')
    const { db } = openDb(indexPath)
    try {
      for (const dirPath of [matrixDir, speedDir]) {
        ingest(db, { path: join(dirPath, 'claude-alpha.jsonl'), provider: 'claude', kind: 'session' })
        ingest(db, { path: join(dirPath, 'codex-alpha.jsonl'), provider: 'codex', kind: 'session' })
      }
      ingest(db, { path: join(matrixDir, 'claude-beta.jsonl'), provider: 'claude', kind: 'session' })
    } finally {
      db.close()
    }
  })

  it('--json отдаёт spendMatrix как есть: клетки, итог и ось', () => {
    expect(execute('breakdown', '--by', 'project-model', ...matrixPeriod, '--json')).toBe(0)
    const matrix = JSON.parse(stdout[0]!) as SpendMatrix & { by: string }

    expect(matrix.by).toBe('project-model')
    expect(matrix.totals).toEqual({
      input: 1660,
      output: 1360,
      cacheWrite: 2650,
      cacheRead: 6600,
      total: 12270,
      requests: 9,
    })
    expect(matrix.rows.map((row) => [row.project, row.totals.total])).toEqual([
      ['alpha', 11090],
      ['beta', 1180],
    ])
    const alpha = matrix.rows[0]!
    // Модель запроса, а не модель сессии: сессия `alpha` открыта на opus-5.
    expect(find(alpha.cells, 'claude-fable-5')).toMatchObject({ inherited: 1800 })
    expect(find(alpha.cells, 'claude-fable-5').totals.total).toBe(5920)
    expect(find(alpha.cells, 'claude-fable-5').totals.requests).toBe(3)
    expect(find(alpha.cells, 'gpt-5.6-sol').totals.total).toBe(2750)
    expect(find(alpha.cells, 'claude-opus-5').totals.total).toBe(2420)
    expect(matrix.rows[1]!.cells).toHaveLength(1)
    // Сумма клеток = сумма строк = сумма маргинали = итог, посчитанный ядром отдельно.
    const cells = matrix.rows.flatMap((row) => row.cells)
    expect(cells.reduce((sum, cell) => sum + cell.totals.total, 0)).toBe(12270)
    expect(matrix.rows.reduce((sum, row) => sum + row.totals.total, 0)).toBe(12270)
    expect(matrix.models.reduce((sum, cell) => sum + cell.totals.total, 0)).toBe(12270)
  })

  it('текстом: все клетки, ≈ только у клетки с inherited, оговорка под таблицей', () => {
    expect(execute('breakdown', '--by', 'project-model', ...matrixPeriod)).toBe(0)
    const lines = stdout[0]!.split('\n')

    const fable = lines.find((line) => line.includes('claude-fable-5'))!
    expect(fable.startsWith('  claude-fable-5')).toBe(true)
    expect(fable).toContain('≈5,9k')
    // Строка проекта и итог точны: длина измерена, деление — нет.
    const alpha = lines.find((line) => /^alpha\b/.test(line))!
    expect(alpha).toContain('11,1k')
    expect(alpha).not.toContain('≈')
    const beta = lines.find((line) => /^beta\b/.test(line))!
    expect(beta).not.toContain('≈')
    const total = lines.find((line) => line.startsWith(t('cli.rowTotal')))!
    expect(total).toContain('12,3k')
    expect(total).not.toContain('≈')
    expect(lines.filter((line) => line.includes('≈'))).toHaveLength(1)
    // Хвост не сворачивается: 3 клетки alpha и 1 клетка beta.
    expect(lines.filter((line) => /^ {2}\S/.test(line))).toHaveLength(4)
    expect(stdout[0]).toContain(t('matrix.inheritedCaveat'))
    // Доли: клетка — от проекта, проект — от периода.
    expect(fable).toContain('53,4%') // 5920 / 11090
    expect(alpha).toContain('90,4%') // 11090 / 12270
  })

  it('--by project-model --session — ошибка аргументов, как --day вместе с --session', () => {
    expect(execute('breakdown', '--by', 'project-model', '--session', 'x')).toBe(2)
    expect(stderr[0]).toBe(t('cli.projectModelSession'))
    expect(stdout).toHaveLength(0)
  })

  it('--days вместе с --session — ошибка; --days 0 — ошибка', () => {
    expect(execute('breakdown', '--session', 'x', '--days', '3')).toBe(2)
    expect(stderr[0]).toBe(t('cli.daysAndSession'))
    stderr.length = 0
    expect(execute('breakdown', '--days', '0')).toBe(2)
    expect(stderr[0]).toContain('--days')
  })

  it('--days действует на все оси: период из N суток до --day включительно', () => {
    expect(execute('breakdown', '--by', 'model', '--day', '2026-08-20', '--days', '1', '--json')).toBe(0)
    const oneDay = JSON.parse(stdout[0]!) as { model: Array<{ key: string }> }
    stdout.length = 0
    expect(execute('breakdown', '--by', 'model', '--day', '2026-08-21', '--days', '5', '--json')).toBe(0)
    const five = JSON.parse(stdout[0]!) as { model: Array<{ key: string }> }
    // Один день 20 августа и пять дней до 21-го видят одни и те же три модели.
    expect(five.model.map((row) => row.key).sort()).toEqual(oneDay.model.map((row) => row.key).sort())
    stdout.length = 0
    expect(execute('breakdown', '--by', 'tool', '--day', '2026-08-28', '--days', '20')).toBe(0)
    expect(stdout[0]).not.toBe(t('cli.emptyRange'))
  })

  it('--by model --json: models — та же маргиналь, что у матрицы, поле model остаётся', () => {
    expect(execute('breakdown', '--by', 'model', ...matrixPeriod, '--json')).toBe(0)
    const report = JSON.parse(stdout[0]!) as {
      by: string
      model: Array<{ key: string; totals: { total: number } }>
      models: MatrixCell[]
    }
    stdout.length = 0
    expect(execute('breakdown', '--by', 'project-model', ...matrixPeriod, '--json')).toBe(0)
    const matrix = JSON.parse(stdout[0]!) as SpendMatrix

    expect(report.by).toBe('model')
    expect(report.models).toEqual(matrix.models)
    expect(report.models.map((cell) => [cell.model, cell.provider, cell.totals.total])).toEqual([
      ['claude-fable-5', 'claude', 5920],
      ['claude-opus-5', 'claude', 3600],
      ['gpt-5.6-sol', 'codex', 2750],
    ])
    // Σ models = Σ model (BreakdownReport): ось прежняя, итог один.
    const sum = (rows: Array<{ totals: { total: number } }>) =>
      rows.reduce((total, row) => total + row.totals.total, 0)
    expect(sum(report.models)).toBe(sum(report.model))
  })

  it('--by model текстом: скорость из MatrixCell.speed, ниже порога — «мало данных»', () => {
    expect(execute('breakdown', '--by', 'model', ...speedPeriod)).toBe(0)
    const lines = stdout[0]!.split('\n')

    // Эталон fixtures/speed: opus 5500 / 9000 мс, 40 тк/с; sol 4500 / 6500, 75 тк/с.
    const opus = lines.find((line) => line.includes('claude-opus-5'))!
    expect(opus).toMatch(/5,5\s+9,0\s+40,0$/)
    const sol = lines.find((line) => line.includes('gpt-5.6-sol'))!
    expect(sol).toMatch(/4,5\s+6,5\s+75,0$/)
    // Sonnet — два измеренных запроса из порога в пять: слова, а не 0,0 и не пустота.
    const sonnet = lines.find((line) => line.includes('claude-sonnet-5'))!
    expect(sonnet).toContain(t('matrix.speedFew'))
    expect(sonnet).toMatch(new RegExp(`${t('matrix.speedFew')}$`))
    expect(stdout[0]).toContain(t('matrix.speedNote'))
    // Провайдер — отдельная колонка: ключ скорости — пара, а не имя.
    expect(opus).toContain('claude')
    expect(sol).toContain('codex')
  })

  it('--by model --json: speed каждой модели — тот же объект, что в эталоне скорости', () => {
    expect(execute('breakdown', '--by', 'model', ...speedPeriod, '--json')).toBe(0)
    const { models } = JSON.parse(stdout[0]!) as { models: MatrixCell[] }

    expect(find(models, 'claude-opus-5').speed).toEqual({
      requests: 6,
      p50Ms: 5500,
      p90Ms: 9000,
      tokensPerSecond: 40,
    })
    expect(find(models, 'gpt-5.6-sol').speed).toEqual({
      requests: 6,
      p50Ms: 4500,
      p90Ms: 6500,
      tokensPerSecond: 75,
    })
    expect('speed' in find(models, 'claude-sonnet-5')).toBe(false)
  })

  it('--by model --session: прежняя ось без скорости и строка о том, почему', () => {
    const { db } = openDb(indexPath)
    const session = db.get<{ id: string }>(
      "SELECT id FROM sessions WHERE project = 'alpha' AND provider = 'claude' LIMIT 1",
    )!.id
    db.close()

    expect(execute('breakdown', '--by', 'model', '--session', session)).toBe(0)
    expect(stdout[0]).toContain(t('cli.speedNeedsRange'))
    expect(stdout[0]).not.toContain(t('matrix.speedNote'))
    expect(stdout[0]).not.toContain(t('matrix.speedFew'))
    expect(stdout[0]).toContain('claude-fable-5')
    stdout.length = 0
    expect(execute('breakdown', '--by', 'model', '--session', session, '--json')).toBe(0)
    const report = JSON.parse(stdout[0]!) as { by: string; models?: unknown }
    expect(report.by).toBe('model')
    expect(report.models).toBeUndefined()
  })

  /**
   * Имя модели у двух провайдеров сразу в индексе не встречалось ни разу, и
   * мутация «искать скорость по имени» живые данные не уронит. Здесь она
   * названа руками: две сессии, один `model`, строки две, а не одна.
   */
  it('одно имя модели у двух провайдеров — две строки', () => {
    const { db } = openDb(indexPath)
    try {
      for (const provider of ['claude', 'codex'] as const) {
        const id = `twin-${provider}`
        const at = Date.parse('2026-08-10T10:00:00.000Z')
        db.run(
          `INSERT INTO sources (path, provider, session_id, inode, size, mtime, offset, parsed_at)
           VALUES (?, ?, ?, 1, 1, 1, 1, ?)`,
          id,
          provider,
          id,
          at,
        )
        db.run(
          `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at, is_sidechain)
           VALUES (?, ?, ?, '/twin', 'twin', ?, ?, 0)`,
          id,
          provider,
          id,
          at,
          at,
        )
        db.run(
          `INSERT INTO requests (
             session_id, seq, request_id, ts, model, input, output, cache_write, cache_read,
             context_tokens, is_sidechain, compacted, synthetic, interjected_bytes, origin
           ) VALUES (?, 0, ?, ?, 'twin-model', 1, 2, 3, 4, 8, 0, 0, 0, 0, 'log')`,
          id,
          id,
          at,
        )
      }
    } finally {
      db.close()
    }

    expect(execute('breakdown', '--by', 'model', ...matrixPeriod, '--json')).toBe(0)
    const { models } = JSON.parse(stdout[0]!) as { models: MatrixCell[] }
    const twins = models.filter((cell) => cell.model === 'twin-model')
    expect(twins.map((cell) => cell.provider).sort()).toEqual(['claude', 'codex'])
    expect(twins.every((cell) => cell.totals.total === 10)).toBe(true)
  })

  it('пустые состояния — те же три слова, что у остальных осей', () => {
    expect(execute('breakdown', '--by', 'project-model', '--day', '2026-01-05')).toBe(0)
    expect(stdout[0]).toBe(t('cli.emptyRange'))
    stdout.length = 0
    expect(execute('breakdown', '--by', 'model', '--day', '2026-01-05')).toBe(0)
    expect(stdout[0]).toBe(t('cli.emptyRange'))
    stdout.length = 0
    indexPath = join(dir, 'empty.sqlite')
    openDb(indexPath).db.close()
    expect(execute('breakdown', '--by', 'project-model')).toBe(0)
    expect(stdout[0]).toBe(t('cli.emptyIndex'))
  })
})

function find(cells: readonly MatrixCell[], model: string): MatrixCell {
  const cell = cells.find((candidate) => candidate.model === model)
  if (cell === undefined) throw new Error(`нет клетки ${model}`)
  return cell
}

function execute(...args: string[]): number {
  return run([...args, '--no-ingest', '--index', indexPath, '--config', configPath])
}

function seedIndex(): void {
  const { db } = openDb(indexPath)
  try {
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
      ingest(db, {
        path: join(claudeDir, `${name}.jsonl`),
        provider: 'claude',
        kind: 'session',
      })
    }
    ingest(db, {
      path: join(claudeDir, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
      provider: 'claude',
      kind: 'subagent',
      parentPath: join(claudeDir, '92cc27dc-193d-4c2c-aef1-843d7d41aeab.jsonl'),
    })
    ingest(db, { path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
  } finally {
    db.close()
  }
}

function ingest(db: ReturnType<typeof openDb>['db'], file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

function addCurrentClaudeRequest(): void {
  const { db } = openDb(indexPath)
  const now = Date.now()
  try {
    db.run(
      `INSERT INTO sources (path, provider, session_id, inode, size, mtime, offset, parsed_at)
       VALUES ('current', 'claude', 'current', 1, 1, 1, 1, ?)`,
      now,
    )
    db.run(
      `INSERT INTO limit_observations (
         source_path, provider, ts, window_minutes, used_percent, resets_at
       ) VALUES ('current-codex', 'codex', ?, 300, 12, ?)`,
      now,
      now + 300 * 60_000,
    )
    db.run(
      `INSERT INTO sessions (
         id, provider, source_path, cwd, project, started_at, ended_at, is_sidechain
       ) VALUES ('current', 'claude', 'current', '/current', 'current', ?, ?, 0)`,
      now,
      now,
    )
    db.run(
      `INSERT INTO requests (
         session_id, seq, request_id, ts, model, input, output, cache_write, cache_read,
         context_tokens, is_sidechain, compacted, synthetic, interjected_bytes, origin
       ) VALUES ('current', 0, 'current', ?, 'claude-test', 1, 2, 3, 4, 8, 0, 0, 0, 0, 'log')`,
      now,
    )
  } finally {
    db.close()
  }
}

function maskNumbers(value: string): string {
  // Суффикс тысяч строчный — как в макете (2.5). Оставь здесь `K`, и маска
  // перестанет маскировать суффикс: снапшот начнёт падать по числам, а не по
  // вёрстке, ради которой он и сделан.
  return value.replace(/\d+(?:[.,]\d+)?(?:[kMB])?/g, '#')
}
