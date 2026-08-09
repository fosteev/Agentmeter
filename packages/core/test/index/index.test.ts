import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  discoverSources,
  ingestAll,
  ingestFile,
  parseSessionFile,
  putSession,
  putSource,
  watchSources,
} from '../../src/index.ts'
import { openDb } from '../../src/index/db.ts'
import type { Db } from '../../src/index/db.ts'
import type { SourceFile } from '../../src/index/discover.ts'

const claudeFixtures = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const codexFixtures = fileURLToPath(new URL('../../../../fixtures/codex/', import.meta.url))
const sessionName = '11111111-1111-4111-8111-111111111111.jsonl'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-index-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('индекс логов', () => {
  it('перечисляет источники по правилам Claude и Codex', () => {
    const { claudeHome, codexHome } = makeHomes()
    const project = join(claudeHome, 'projects', '-proj')
    mkdirSync(
      join(project, '11111111-1111-4111-8111-111111111111', 'subagents', 'workflows', 'wf_1'),
      {
        recursive: true,
      },
    )
    copyFileSync(join(claudeFixtures, 'plain.jsonl'), join(project, sessionName))
    copyFileSync(
      join(claudeFixtures, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
      join(
        project,
        '11111111-1111-4111-8111-111111111111',
        'subagents',
        'workflows',
        'wf_1',
        'agent-a6bf337b0067775dd.jsonl',
      ),
    )
    writeFileSync(
      join(
        project,
        '11111111-1111-4111-8111-111111111111',
        'subagents',
        'workflows',
        'wf_1',
        'journal.jsonl',
      ),
      '{}\n',
    )

    const codexDay = join(codexHome, 'sessions', '2026', '06', '15')
    mkdirSync(codexDay, { recursive: true })
    copyFileSync(join(codexFixtures, 'rollout.jsonl'), join(codexDay, 'rollout-test.jsonl'))

    const files = discoverSources({ claudeHome, codexHome })
    expect(files.map((file) => [file.provider, file.kind, basename(file.path)])).toEqual([
      ['claude', 'session', sessionName],
      ['claude', 'subagent', 'agent-a6bf337b0067775dd.jsonl'],
      ['codex', 'session', 'rollout-test.jsonl'],
    ])
    expect(files.find((file) => file.kind === 'subagent')?.parentPath).toBe(
      join(project, sessionName),
    )
  })

  it('putSession повторным вызовом не плодит строки', () => {
    const sourcePath = join(claudeFixtures, 'plain.jsonl')
    const file: SourceFile = { path: sourcePath, provider: 'claude', kind: 'session' }
    const stat = statFor(sourcePath)
    const result = parseSessionFile(sourcePath)

    putSource(db, file, stat)
    putSession(db, result, file)
    const first = counts()
    putSource(db, file, stat)
    putSession(db, result, file)

    expect(counts()).toEqual(first)
    expect(
      db.get<{ input: number; output: number; cacheWrite: number; cacheRead: number }>(
        'SELECT sum(input) AS input, sum(output) AS output, sum(cache_write) AS cacheWrite, sum(cache_read) AS cacheRead FROM requests',
      ),
    ).toEqual(sumRequests(result.requests))
  })

  it('ingestFile перечитывает изменившийся файл целиком', () => {
    const sourcePath = join(dir, sessionName)
    const full = readFileSync(join(claudeFixtures, 'plain.jsonl'), 'utf8')
    writeFileSync(sourcePath, full.slice(0, Math.floor(full.length * 0.8)))
    const file: SourceFile = { path: sourcePath, provider: 'claude', kind: 'session' }

    expect(ingestFile(db, file).parsed).toBe(true)
    writeFileSync(sourcePath, full)
    expect(ingestFile(db, file).parsed).toBe(true)
    expect(
      db.get<{ input: number; output: number; cacheWrite: number; cacheRead: number }>(
        'SELECT sum(input) AS input, sum(output) AS output, sum(cache_write) AS cacheWrite, sum(cache_read) AS cacheRead FROM requests',
      ),
    ).toEqual(sumRequests(parseSessionFile(sourcePath).requests))
  })

  it('ingestAll повторно пропускает неизменившиеся файлы', () => {
    const { claudeHome, codexHome } = makeHomes()
    const project = join(claudeHome, 'projects', '-proj')
    mkdirSync(project, { recursive: true })
    copyFileSync(join(claudeFixtures, 'plain.jsonl'), join(project, sessionName))

    const first = ingestAll(db, { claudeHome, codexHome })
    const second = ingestAll(db, { claudeHome, codexHome })
    expect(first.parsed).toBe(1)
    expect(second.parsed).toBe(0)
    expect(second.skipped).toBe(1)
    expect(counts()).toEqual({
      sessions: 1,
      requests: first.requests,
      tools: db.get<{ count: number }>('SELECT count(*) AS count FROM tool_calls')?.count ?? 0,
    })
  })

  it('watchSources ловит дописанный файл', async () => {
    const { claudeHome, codexHome } = makeHomes()
    const project = join(claudeHome, 'projects', '-proj')
    mkdirSync(project, { recursive: true })
    const sourcePath = join(project, sessionName)
    const full = readFileSync(join(claudeFixtures, 'plain.jsonl'), 'utf8')
    writeFileSync(sourcePath, full.slice(0, Math.floor(full.length * 0.8)))
    ingestAll(db, { claudeHome, codexHome })

    let batches = 0
    const watcher = watchSources(db, {
      claudeHome,
      codexHome,
      debounceMs: 30,
      rediscoverMs: 10_000,
      onBatch: () => {
        batches += 1
      },
    })
    try {
      writeFileSync(sourcePath, full)
      await waitFor(
        () => batches > 0 && counts().requests === parseSessionFile(sourcePath).requests.length,
      )
    } finally {
      watcher.close()
    }
  })
})

function makeHomes(): { claudeHome: string; codexHome: string } {
  const claudeHome = join(dir, '.claude')
  const codexHome = join(dir, '.codex')
  mkdirSync(join(claudeHome, 'projects'), { recursive: true })
  mkdirSync(join(codexHome, 'sessions'), { recursive: true })
  return { claudeHome, codexHome }
}

function statFor(path: string): { inode: number; size: number; mtime: number } {
  const stat = statSync(path)
  return { inode: stat.ino, size: stat.size, mtime: Math.round(stat.mtimeMs) }
}

function counts(): { sessions: number; requests: number; tools: number } {
  return {
    sessions: db.get<{ count: number }>('SELECT count(*) AS count FROM sessions')?.count ?? 0,
    requests: db.get<{ count: number }>('SELECT count(*) AS count FROM requests')?.count ?? 0,
    tools: db.get<{ count: number }>('SELECT count(*) AS count FROM tool_calls')?.count ?? 0,
  }
}

function sumRequests(
  requests: { input: number; output: number; cacheWrite: number; cacheRead: number }[],
): {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
} {
  return requests.reduce(
    (totals, request) => {
      totals.input += request.input
      totals.output += request.output
      totals.cacheWrite += request.cacheWrite
      totals.cacheRead += request.cacheRead
      return totals
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  )
}

async function waitFor(ok: () => boolean): Promise<void> {
  const until = Date.now() + 2_000
  while (Date.now() < until) {
    if (ok()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition timeout')
}
