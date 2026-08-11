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
  ingestSteps,
  parseSessionFile,
  putSession,
  putSource,
  watchSources,
} from '../../src/index.ts'
import { fileId } from '../../src/index/ingest.ts'
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

  /**
   * Ловит 64-битный идентификатор файла с Windows, записанный в базу числом.
   * Записать его SQLite даёт, а прочитать обратно нельзя — `node:sqlite` роняет
   * выборку с `ERR_OUT_OF_RANGE`, и падает не первый разбор, а дочитывание. На
   * Windows это ломало индекс целиком: `ingestFile` второй раз по тому же файлу
   * выбрасывал исключение. На POSIX проверка не сработает никогда — inode там
   * помещается в число, — поэтому она стоит отдельно от разбора.
   */
  it('идентификатор файла шире числа не едет в базу', () => {
    const windows = 12103423999340064
    expect(Number.isSafeInteger(windows)).toBe(false)
    expect(fileId(windows)).toBe(0)
    // Обычный inode не трогается: по нему видно ротацию файла под тем же путём.
    expect(fileId(8675309)).toBe(8675309)

    putSource(db, { path: '/log.jsonl', provider: 'claude', kind: 'session' }, {
      inode: fileId(windows),
      size: 1,
      mtime: 2,
    })
    expect(db.get<{ inode: number }>('SELECT inode FROM sources')?.inode).toBe(0)
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

  // Потолок теста задан явно: у vitest он по умолчанию 5 с, и щедрые 15 с
  // внутри waitFor до сих пор были недостижимы — тест умирал раньше, чем
  // успевал дождаться. Проверяется контракт «вотчер дочитает изменившийся
  // файл», а каким путём — событием fs.watch или запасным переобходом —
  // деталь реализации: на сетевой файловой системе события не приходят вовсе,
  // ради чего переобход и существует.
  it('watchSources ловит дописанный файл', { timeout: 20_000 }, async () => {
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
      rediscoverMs: 1_000,
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
  // Потолок щедрый нарочно: условие проверяется каждые 25 мс и выходит сразу,
  // как только сойдётся, поэтому ожидание ничего не стоит на здоровой машине.
  // При двух секундах тест мигал примерно раз на три полных прогона — не из-за
  // индекса, а из-за задержки fs.watch на загруженной macOS.
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    if (ok()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition timeout')
}

describe('проход кусками (2.8)', () => {
  /** Источники с настоящими файлами: на пустом каталоге проверять нечего. */
  function homesWithFiles(): { claudeHome: string; codexHome: string } {
    const homes = makeHomes()
    const project = join(homes.claudeHome, 'projects', '-proj')
    mkdirSync(project, { recursive: true })
    for (const name of ['plain', 'mcp', 'parallel']) {
      copyFileSync(
        join(claudeFixtures, `${name}.jsonl`),
        join(project, `1111111${name.length}-1111-4111-8111-11111111111${name.length}.jsonl`),
      )
    }
    const codexDay = join(homes.codexHome, 'sessions', '2026', '06', '15')
    mkdirSync(codexDay, { recursive: true })
    copyFileSync(join(codexFixtures, 'rollout.jsonl'), join(codexDay, 'rollout-test.jsonl'))
    return homes
  }

  /**
   * Ловит две ошибки разом. Первая: прогресс, который не двигается, — полоса
   * индексирования тогда честно показывает ноль до самого конца. Вторая, важнее:
   * проход с остановками, индексирующий не то же самое, что проход разом. Он
   * существует только ради того, чтобы окно успевало рисоваться, и разойдись
   * они в цифрах — расхождение было бы видно один раз при первом запуске и
   * больше никогда.
   */
  it('даёт растущий прогресс в байтах и тот же индекс, что и разом', () => {
    const sources = homesWithFiles()

    const steps: Array<{ bytesDone: number; bytesTotal: number; filesDone: number }> = []
    const run = ingestSteps(db, { ...sources, progress: true })
    let step = run.next()
    while (!step.done) {
      steps.push(step.value)
      step = run.next()
    }
    const sliced = step.value

    expect(steps.length).toBe(sliced.scanned)
    expect(steps.length).toBeGreaterThan(1)
    const last = steps.at(-1)!
    expect(last.filesDone).toBe(sliced.scanned)
    expect(last.bytesTotal).toBeGreaterThan(0)
    expect(last.bytesDone).toBe(last.bytesTotal)
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.bytesDone).toBeGreaterThan(steps[i - 1]!.bytesDone)
    }

    const other = openDb(join(dir, 'whole.sqlite')).db
    const whole = ingestAll(other, sources)
    expect({ sessions: sliced.sessions, requests: sliced.requests }).toEqual({
      sessions: whole.sessions,
      requests: whole.requests,
    })
    other.close()
  })

  /**
   * Ловит лишнюю работу на каждом событии вотчера: `ingestAll` зовётся вотчером
   * на каждое движение файла, и обход `stat` по всем источникам ради прогресса,
   * которого никто не спрашивал, — это то же самое, что пересборка окон лимита
   * из читающего пути (долг 1.10), только тише.
   *
   * Источники здесь непустые нарочно: на пустом каталоге шагов не будет ни при
   * каком коде, и проверка зеленела бы всегда — так она и была написана
   * сначала.
   */
  it('без запроса прогресса шагов нет вовсе', () => {
    const run = ingestSteps(db, homesWithFiles())
    const first = run.next()
    expect(first.done).toBe(true)
    expect(first.value).toMatchObject({ scanned: 4 })
  })
})
