import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLiveLayer,
  ensureLimitWindows,
  ingestFile,
  readLimitWindows,
  type SessionLifetime,
  type SourceFile,
} from '../../src/index.ts'
import { openDb, type Db } from '../../src/index/db.ts'
import type { ClaudeLimits } from '../../src/config/types.ts'

const claudeFixtures = fileURLToPath(new URL('../../../../fixtures/claude/', import.meta.url))
const unknownLimits: ClaudeLimits = {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: null,
  plan: null,
}

let tmp: string
let db: Db

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agentmeter-live-'))
  db = openDb(join(tmp, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Дом Claude с одним живым процессом — им притворяется сам тест. */
function claudeHomeWith(sessionId: string, startedAt = Date.now()): string {
  const home = join(tmp, 'claude')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(
    join(home, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd: '/proj/live',
      startedAt,
      entrypoint: 'claude-vscode',
      version: '2.1.226',
    }),
  )
  return home
}

function ingestClaude(name: string): void {
  const file: SourceFile = {
    path: join(claudeFixtures, `${name}.jsonl`),
    provider: 'claude',
    kind: 'session',
  }
  ingestFile(db, file)
}

function sessionIdOf(): string {
  return db.get<{ id: string }>('SELECT id FROM sessions LIMIT 1')!.id
}

describe('живой слой', () => {
  it('показывает живую сессию с расходом из индекса', () => {
    ingestClaude('plain')
    const sessionId = sessionIdOf()
    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(sessionId),
      codexHome: join(tmp, 'нет'),
    })

    const snapshot = live.snapshot()
    const agent = snapshot.agents.find((a) => a.sessionId === sessionId)

    expect(agent).toBeDefined()
    // Точка входа нормализована: на диске `claude-vscode`, в контракте 0.2 — `vscode`.
    expect(agent!.entrypoint).toBe('vscode')
    expect(agent!.liveness).toBe('process')
    expect(agent!.tokens).toBeGreaterThan(0)
    expect(agent!.requests).toBeGreaterThan(0)
  })

  /**
   * Ловит двойной показ: транскрипт сабагента лежит в индексе отдельной
   * сессией (так и надо, 1.3), но своего процесса у него нет. Если не свернуть
   * его в родителя, один работающий агент показывается несколькими, и число в
   * шапке попапа врёт.
   */
  it('сворачивает сабагента в родителя, а не показывает отдельным агентом', () => {
    ingestClaude('sidechain')
    const parentId = sessionIdOf()
    ingestFile(db, {
      path: join(claudeFixtures, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
      provider: 'claude',
      kind: 'subagent',
      parentPath: join(claudeFixtures, `${parentId}.jsonl`),
    })
    const subagentTokens = db.get<{ tokens: number }>(
      `SELECT sum(input + output + cache_write + cache_read) AS tokens
       FROM requests JOIN sessions ON sessions.id = requests.session_id
       WHERE sessions.parent_session_id IS NOT NULL`,
    )!.tokens

    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(parentId),
      codexHome: join(tmp, 'нет'),
    })
    const snapshot = live.snapshot()

    expect(snapshot.agents).toHaveLength(1)
    expect(subagentTokens).toBeGreaterThan(0)
    expect(snapshot.agents[0]!.tokens).toBeGreaterThan(subagentTokens)
  })

  /**
   * Ловит долг 1.10: пересборку окон из читающего пути. Раньше её делал
   * `limitsReport`, то есть полный проход по запросам Claude плюс скрытая
   * запись при каждом опросе трея — раз в секунду.
   */
  it('снимок не переписывает окна лимита', () => {
    ingestClaude('plain')
    ensureLimitWindows(db, unknownLimits)
    const before = readLimitWindows(db).length
    // Метка, которую пересборка снесла бы вместе со всей таблицей.
    db.run(
      `INSERT INTO limit_windows (provider, kind, window_minutes, starts_at, resets_at,
         used_percent, observed_at, exact)
       VALUES ('claude', 'other', 1, 1, 2, NULL, 1, 0)`,
    )

    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(sessionIdOf()),
      codexHome: join(tmp, 'нет'),
      claudeLimits: unknownLimits,
    })
    for (let i = 0; i < 20; i += 1) live.snapshot()

    expect(readLimitWindows(db)).toHaveLength(before + 1)
  })
})

describe('замер времени жизни', () => {
  function readJournal(path: string): SessionLifetime[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as SessionLifetime)
  }

  /**
   * Ловит перезапись `firstSeenAt` на каждом опросе: время жизни тогда всегда
   * ≈ 0, замер хвостовых прогревов молча даёт ноль, и долг 1.3 закрывается
   * второй раз неправдой.
   */
  it('не двигает firstSeenAt между снимками', () => {
    ingestClaude('plain')
    const path = join(tmp, 'lifetimes.jsonl')
    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(sessionIdOf()),
      codexHome: join(tmp, 'нет'),
      lifetimesPath: path,
      lifetimeFlushMs: 0,
    })

    live.snapshot(1_000)
    live.snapshot(2_000)
    live.snapshot(3_000)

    const last = live.lifetimes()[0]!
    expect(last.firstSeenAt).toBe(1_000)
    expect(last.lastSeenAt).toBe(3_000)
    expect(last.endedAt).toBeNull()
  })

  it('записывает смерть процесса, когда она наблюдена', () => {
    ingestClaude('plain')
    const path = join(tmp, 'lifetimes.jsonl')
    const home = claudeHomeWith(sessionIdOf())
    const live = createLiveLayer(db, {
      claudeHome: home,
      codexHome: join(tmp, 'нет'),
      lifetimesPath: path,
    })

    live.snapshot(1_000)
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    live.snapshot(5_000)

    const record = live.lifetimes()[0]!
    expect(record.endedAt).toBe(5_000)
    // Искомое 1.3: сколько процесс прожил после последнего записанного запроса.
    expect(record.lastRequestTs).not.toBeNull()
    expect(readJournal(path).at(-1)!.endedAt).toBe(5_000)
  })

  it('переживает перезапуск: журнал читается обратно', () => {
    ingestClaude('plain')
    const path = join(tmp, 'lifetimes.jsonl')
    const home = claudeHomeWith(sessionIdOf())

    const first = createLiveLayer(db, {
      claudeHome: home,
      codexHome: join(tmp, 'нет'),
      lifetimesPath: path,
    })
    first.snapshot(1_000)

    const second = createLiveLayer(db, {
      claudeHome: home,
      codexHome: join(tmp, 'нет'),
      lifetimesPath: path,
    })
    second.snapshot(9_000)

    const record = second.lifetimes()[0]!
    expect(record.firstSeenAt).toBe(1_000)
    expect(record.lastSeenAt).toBe(9_000)
  })
})

describe('пересборка окон по отпечатку входа', () => {
  /**
   * Ловит «убрали пересборку из чтения и забыли отпечаток»: после правки
   * потолка плана проценты замерзали бы на `null`, и устаревший ответ выглядел
   * бы как честное «план не задан».
   */
  it('пересобирает при смене потолков и молчит, когда вход тот же', () => {
    ingestClaude('plain')

    expect(ensureLimitWindows(db, unknownLimits)).not.toBeNull()
    expect(ensureLimitWindows(db, unknownLimits)).toBeNull()

    const calibrated: ClaudeLimits = {
      fiveHourCap: 100_000_000,
      weeklyCap: 500_000_000,
      cacheReadWeight: 0.2,
      plan: 'max',
    }
    expect(ensureLimitWindows(db, calibrated)).not.toBeNull()
    expect(ensureLimitWindows(db, calibrated)).toBeNull()

    const claude = readLimitWindows(db).filter((window) => window.provider === 'claude')
    expect(claude.length).toBeGreaterThan(0)
    expect(claude.every((window) => window.usedPercent !== null)).toBe(true)
  })
})
