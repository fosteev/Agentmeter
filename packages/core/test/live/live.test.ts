import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
   * Ловит правило 2.1 «тишина = простой», применённое к законченному ходу.
   * Фикстура кончается ответом модели с `end_turn`, за которым лежат три
   * учётные записи `system` — то есть проверяется и пропуск учётных, и вывод
   * состояния из хода. Метка снимка на час позже последней записи: по тишине
   * это был бы «простой», по ходу — «ждёт ответа», и правильно второе.
   */
  it('видит законченный ход как ожидание человека, а не как простой', () => {
    ingestClaude('plain')
    const sessionId = sessionIdOf()
    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(sessionId),
      codexHome: join(tmp, 'нет'),
    })

    const agent = live.snapshot(Date.now() + 3_600_000).agents[0]!
    expect(agent.turn).toBe('turn-end')
    expect(agent.state).toBe('waiting')
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

describe('завершившийся агент', () => {
  /**
   * Ловит «процесса нет — строки нет». Макет держит гашеную строку
   * «завершился 2 мин назад» (строки 164–169), и без выдержки попап терял бы
   * агента ровно в тот момент, когда человек подходит посмотреть, чем кончилось.
   */
  it('держится в снимке выдержку и исчезает после неё', () => {
    ingestClaude('plain')
    const home = claudeHomeWith(sessionIdOf())
    const live = createLiveLayer(db, {
      claudeHome: home,
      codexHome: join(tmp, 'нет'),
      doneGraceMs: 60_000,
    })

    live.snapshot(1_000_000)
    rmSync(join(home, 'sessions'), { recursive: true, force: true })

    const justDied = live.snapshot(1_010_000).agents[0]!
    expect(justDied.state).toBe('done')
    expect(justDied.endedAt).toBe(1_010_000)
    // Темп мёртвого — ноль: «жжёт 40k/мин» под «завершился» читается как
    // «всё ещё жжёт».
    expect(justDied.rate).toBe(0)

    // Момент смерти не переставляется на каждом опросе, иначе строка навсегда
    // осталась бы «завершился только что».
    expect(live.snapshot(1_050_000).agents[0]!.endedAt).toBe(1_010_000)
    expect(live.snapshot(1_100_000).agents).toHaveLength(0)
  })

  /**
   * Ловит самое дорогое из возможного здесь: сдвиг замера 1.3 на выдержку.
   * Завершившийся агент остаётся в снимке `doneGraceMs`, и если считать его
   * живым, `endedAt` в журнале уедет на всю выдержку. Журнал хвостовых
   * прогревов — единственные данные проекта, которые задним числом не
   * восстановить: индекс перечитывается из логов, а это нет.
   */
  it('не сдвигает смерть в журнале на выдержку показа', () => {
    ingestClaude('plain')
    const path = join(tmp, 'lifetimes.jsonl')
    const home = claudeHomeWith(sessionIdOf())
    const live = createLiveLayer(db, {
      claudeHome: home,
      codexHome: join(tmp, 'нет'),
      lifetimesPath: path,
      doneGraceMs: 600_000,
    })

    live.snapshot(1_000_000)
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    live.snapshot(1_010_000)
    live.snapshot(1_020_000)

    const record = live.lifetimes()[0]!
    expect(record.endedAt).toBe(1_010_000)
    expect(record.lastSeenAt).toBe(1_000_000)
  })
})

describe('темп', () => {
  /**
   * Ловит знаменатель: расход сессии, делённый на окно усреднения вместо
   * прожитого времени, и наоборот. Фикстура целиком лежит в прошлом, поэтому в
   * хвостовое окно не попадает ни один запрос — темп обязан быть нулём, а не
   * «весь расход за пять минут».
   */
  it('не выдаёт весь расход сессии за темп последних минут', () => {
    ingestClaude('plain')
    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(sessionIdOf()),
      codexHome: join(tmp, 'нет'),
    })

    const agent = live.snapshot(Date.now()).agents[0]!
    expect(agent.tokens).toBeGreaterThan(0)
    expect(agent.rate).toBe(0)
  })

  /**
   * Ловит пол усреднения: одна точка темпа не образует, а сессия возрастом в
   * секунду с запросом на 200k при делении на её возраст даёт 12M/мин.
   */
  it('считает темп по прожитому времени, обрезанному окном', () => {
    ingestClaude('plain')
    const startedAt = Date.now()
    // Опрос на три минуты позже старта: сессия моложе окна усреднения, значит
    // знаменателем должен стать её возраст, а не окно.
    const at = startedAt + 180_000
    db.run('UPDATE requests SET ts = ?', at - 60_000)
    const tokens = db.get<{ tokens: number }>(
      `SELECT sum(input + output + cache_write + cache_read) AS tokens FROM requests`,
    )!.tokens

    const live = createLiveLayer(db, {
      claudeHome: claudeHomeWith(sessionIdOf(), startedAt),
      codexHome: join(tmp, 'нет'),
      rateWindowMs: 300_000,
    })

    const agent = live.snapshot(at).agents[0]!
    expect(agent.rate).toBe(Math.round((tokens * 60_000) / 180_000))
  })
})

describe('порядок строк в снимке', () => {
  /**
   * Роллаут Codex с заданным хвостом и заданной свежестью. Codex, а не Claude,
   * потому что живость там — свежесть файла: четыре состояния в одном снимке
   * иначе не собрать, реестр процессов знает ровно один живой pid — свой.
   */
  function rollout(dir: string, id: string, kind: string, at: number): string {
    const path = join(dir, `rollout-2026-08-11T00-00-00-${id}.jsonl`)
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(at).toISOString(),
        payload: { type: kind },
      })}\n`,
    )
    utimesSync(path, at / 1000, at / 1000)
    return path
  }

  /**
   * Ловит порядок по времени старта — тот, что был здесь до 5.6.
   *
   * Список открывают вопросом «что происходит сейчас», а по старту наверх
   * всплывает сессия, начатая утром и с тех пор молчащая: работающий агент
   * уезжает под неё, а при десяти чатах — и под скролл. Порядок проверяется на
   * настоящем снимке, а не на компараторе: сортировка, которую забыли позвать,
   * зеленела бы на любом тесте самой функции.
   */
  it('работающие сверху, ждущие под ними, молчащие и завершившиеся ниже', () => {
    const at = Date.now()
    const day = new Date(at)
    const home = join(tmp, 'codex')
    const dir = join(
      home,
      'sessions',
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    )
    mkdirSync(dir, { recursive: true })

    // Ход у агента и движение в логе — «работает»; двое, чтобы проверить и
    // порядок внутри группы.
    rollout(dir, '00000000-0000-4000-8000-000000000001', 'task_started', at - 30_000)
    rollout(dir, '00000000-0000-4000-8000-000000000002', 'task_started', at - 5_000)
    // Ход у человека — «ждёт ответа», и тишина тут ничего не меняет.
    rollout(dir, '00000000-0000-4000-8000-000000000003', 'task_complete', at - 20_000)
    // Ход у агента, но в логе тишина дольше порога — «молчит».
    rollout(dir, '00000000-0000-4000-8000-000000000004', 'task_started', at - 600_000)
    // Пятый пропадёт между опросами и станет «завершился».
    const doomed = rollout(dir, '00000000-0000-4000-8000-000000000005', 'task_started', at - 5_000)

    const live = createLiveLayer(db, {
      claudeHome: join(tmp, 'нет'),
      codexHome: home,
      idleMs: 60_000,
      codexSilenceMs: 30 * 60_000,
      doneGraceMs: 5 * 60_000,
    })
    live.snapshot(at)
    rmSync(doomed)
    const agents = live.snapshot(at + 1_000).agents

    expect(agents.map((agent) => agent.state)).toEqual([
      'working',
      'working',
      'waiting',
      'idle',
      'done',
    ])
    // Внутри группы порядок прежний — по старту, старший выше: иначе строки
    // прыгали бы местами на каждом опросе.
    expect(agents[0]!.startedAt).toBeLessThan(agents[1]!.startedAt)
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
