import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestFile, openDb, type SourceFile } from '@agentmeter/core'
import { run } from '../src/main.ts'

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))

let dir: string
let indexPath: string
let configPath: string
let stdout: string[]
let stderr: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-cli-'))
  indexPath = join(dir, 'index.sqlite')
  configPath = join(dir, 'missing-config.json')
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
      #:#  #        #"
    `)
  })

  it('tasks сворачивает сабагента в родителя в JSON', () => {
    expect(execute('tasks', '--day', '2026-07-10', '--json')).toBe(0)
    const result = JSON.parse(stdout[0]!) as {
      rows: Array<{ sessionId: string; subagents: number }>
    }

    expect(result.rows.some((row) => row.sessionId === 'a6bf337b0067775dd')).toBe(false)
    expect(
      result.rows.find((row) => row.sessionId === '92cc27dc-193d-4c2c-aef1-843d7d41aeab')
        ?.subagents,
    ).toBe(1)
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

  it('неверные аргументы возвращают 2', () => {
    expect(execute('today', '--provider', 'other')).toBe(2)
    expect(stderr[0]).toContain('claude или codex')
  })
})

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
  return value.replace(/\d+(?:[.,]\d+)?(?:[KMB])?/g, '#')
}
