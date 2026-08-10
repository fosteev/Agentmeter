/**
 * Проверка живого слоя на реальных процессах и живых логах.
 *
 *     node --experimental-strip-types scripts/probe/live-probe.ts
 *
 * Девять проверок. Каждая названа по поломке, которую обязана поймать, а не по
 * форме сравнения: проверка, написанная под форму, зеленеет на сломанном коде.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  createLiveLayer,
  dayRange,
  defaultClaudeHome,
  defaultCodexHome,
  ensureLimitWindows,
  ingestAll,
  openDb,
  readLimitWindows,
  type ClaudeLimits,
} from '../../packages/core/src/index.ts'
import { processState } from '../../packages/core/src/live/process.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-live-probe-'))
const claudeHome = defaultClaudeHome()
const codexHome = defaultCodexHome()
const unknownLimits: ClaudeLimits = {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: null,
  plan: null,
}

const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const ingest = ingestAll(db, { claudeHome, codexHome, claudeLimits: unknownLimits })
  const live = createLiveLayer(db, { claudeHome, codexHome, claudeLimits: unknownLimits })
  const snapshot = live.snapshot()

  const files = sessionFiles()
  const aliveOnDisk = files.filter((file) => processState(file.pid) === 'alive')
  const shown = new Set(snapshot.agents.map((agent) => agent.sessionId))
  const dead = files.filter((file) => processState(file.pid) !== 'alive')

  // 1. Ловит: разбор молча выбросил живую сессию — агент работает, а в трее пусто.
  const missing = aliveOnDisk.filter((file) => !shown.has(file.sessionId))
  const ghosts = dead.filter((file) => shown.has(file.sessionId))
  report(
    1,
    'живые не теряются, мёртвые не показываются',
    `files=${files.length} alive=${aliveOnDisk.length} shown=${snapshot.agents.length} missing=${missing.length} ghosts=${ghosts.length}`,
    aliveOnDisk.length > 0 && missing.length === 0 && ghosts.length === 0,
  )

  // 2. Ловит: возврат к белому списку из контракта, где нет `claude-vscode` и
  //    `claude-desktop`, — сегодня это 8 живых сессий из 9 в «неизвестно».
  const withRaw = aliveOnDisk.filter((file) => file.entrypointRaw !== undefined)
  const unknownEntrypoints = snapshot.agents.filter(
    (agent) =>
      agent.provider === 'claude' &&
      agent.entrypoint === 'unknown' &&
      withRaw.some((file) => file.sessionId === agent.sessionId),
  )
  report(
    2,
    'точка входа распознана',
    `с полем=${withRaw.length} unknown=${unknownEntrypoints.length} warnings=${snapshot.warnings.length}`,
    withRaw.length > 0 && unknownEntrypoints.length === 0,
  )

  // 3. Ловит: пересборку окон из читающего пути — долг 1.10. Метка в таблице
  //    исчезает вместе со всей таблицей, если снимок её пересобирает.
  const beforeWindows = readLimitWindows(db).length
  db.run(
    `INSERT INTO limit_windows (provider, kind, window_minutes, starts_at, resets_at,
       used_percent, observed_at, exact)
     VALUES ('claude', 'other', 1, 1, 2, NULL, 1, 0)`,
  )
  for (let i = 0; i < 20; i += 1) live.snapshot()
  const afterWindows = readLimitWindows(db).length
  report(
    3,
    'снимок ничего не пишет',
    `окон до=${beforeWindows} после 20 снимков=${afterWindows} (ожидалось ${beforeWindows + 1})`,
    afterWindows === beforeWindows + 1,
  )
  db.run('DELETE FROM limit_windows WHERE kind = ? AND window_minutes = 1', 'other')

  // 4. Ловит: возвращённый полный проход по requests в путь опроса. Трей
  //    опрашивает раз в секунду-две, и такой проход становится постоянной нагрузкой.
  const times: number[] = []
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now()
    live.snapshot()
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]!
  report(
    4,
    'снимок дёшев',
    `медиана=${median.toFixed(1)} мс худший=${times.at(-1)!.toFixed(1)} мс запросов в индексе=${ingest.requests}`,
    median < 50,
  )

  // 5. Ловит: «убрали пересборку из чтения и забыли отпечаток» — после правки
  //    потолка плана проценты замерзают на null, и устаревший ответ выглядит
  //    как честное «план не задан».
  const beforeCalibration = readLimitWindows(db).filter(
    (window) => window.provider === 'claude' && window.usedPercent !== null,
  ).length
  const calibrated: ClaudeLimits = {
    fiveHourCap: 100_000_000,
    weeklyCap: 2_000_000_000,
    cacheReadWeight: 0.2,
    plan: 'проба',
  }
  ensureLimitWindows(db, calibrated)
  const afterCalibration = readLimitWindows(db).filter(
    (window) => window.provider === 'claude' && window.usedPercent !== null,
  ).length
  const noopRebuild = ensureLimitWindows(db, calibrated)
  report(
    5,
    'проценты не замерзают после смены конфига',
    `с процентом до=${beforeCalibration} после=${afterCalibration} повторная пересборка=${noopRebuild === null ? 'нет' : 'есть'}`,
    beforeCalibration === 0 && afterCalibration > 0 && noopRebuild === null,
  )
  ensureLimitWindows(db, unknownLimits)

  // 6. Ловит: перезапись firstSeenAt на каждом опросе — время жизни всегда ≈ 0,
  //    и замер хвостовых прогревов молча даёт ноль.
  const journalPath = join(temp, 'lifetimes.jsonl')
  const measured = createLiveLayer(db, {
    claudeHome,
    codexHome,
    lifetimesPath: journalPath,
    lifetimeFlushMs: 0,
  })
  measured.snapshot(1_000)
  measured.snapshot(2_000)
  measured.snapshot(3_000)
  const records = measured.lifetimes()
  const frozenFirstSeen = records.every((record) => record.firstSeenAt === 1_000)
  const movedLastSeen = records.every((record) => record.lastSeenAt === 3_000)
  report(
    6,
    'время жизни не обнуляется',
    `наблюдений=${records.length} firstSeenAt неподвижен=${frozenFirstSeen} lastSeenAt растёт=${movedLastSeen}`,
    records.length > 0 && frozenFirstSeen && movedLastSeen,
  )

  // 7. Ловит: потерю единственных данных, которые не восстанавливаются ниоткуда.
  //    Индекс сносится и перечитывается при каждой несовместимой миграции.
  const journalBefore = readFileSync(journalPath, 'utf8')
  rmSync(join(temp, 'index.sqlite'), { force: true })
  const journalAfter = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
  report(
    7,
    'замер переживает пересборку индекса',
    `строк до=${lines(journalBefore)} после сноса базы=${lines(journalAfter)}`,
    lines(journalBefore) > 0 && journalBefore === journalAfter,
  )

  // 8. Ловит: «сутки ровно 24 часа» — дважды в год расход часа удваивается или
  //    пропадает, потому что соседние дни перекрываются или расходятся.
  const originalTz = process.env['TZ']
  process.env['TZ'] = 'Europe/Berlin'
  let seams = 0
  let shortOrLong = 0
  for (const day of ['2026-03-29', '2026-10-25']) {
    const at = Date.parse(`${day}T12:00:00.000Z`)
    const previous = dayRange(at, 0, -1)
    const current = dayRange(at, 0)
    const next = dayRange(at, 0, 1)
    if (previous.to !== current.from || current.to !== next.from) seams += 1
    if (current.to - current.from !== 24 * 60 * 60 * 1000) shortOrLong += 1
  }
  if (originalTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = originalTz
  report(
    8,
    'сутки стыкуются на переводе часов',
    `разрывов=${seams} суток не по 24 часа=${shortOrLong} из 2`,
    seams === 0 && shortOrLong === 2,
  )

  // 9. Ловит: период опроса, при котором критерий этапа не выполняется в
  //    принципе. Снимок мгновенный, поэтому «видна < 2 с» — это pollMs плюс
  //    стоимость снимка, и поставленный по вкусу pollMs=2000 промахивается
  //    мимо критерия ровно на эту стоимость.
  const fakeHome = join(temp, 'claude-fake')
  mkdirSync(join(fakeHome, 'sessions'), { recursive: true })
  const watcher = createLiveLayer(db, { claudeHome: fakeHome, codexHome: join(temp, 'нет') })
  const emptyBefore = watcher.snapshot().agents.length
  writeFileSync(
    join(fakeHome, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: 'проба-появления',
      cwd: '/proj/probe',
      startedAt: Date.now(),
      entrypoint: 'claude-vscode',
    }),
  )
  const appearStarted = performance.now()
  const appeared = watcher.snapshot().agents.length === 1
  const appearMs = performance.now() - appearStarted + DEFAULT_CONFIG.live.pollMs
  rmSync(join(fakeHome, 'sessions', `${process.pid}.json`), { force: true })
  const vanishStarted = performance.now()
  const vanished = watcher.snapshot().agents.length === 0
  const vanishMs = performance.now() - vanishStarted + DEFAULT_CONFIG.live.pollMs
  report(
    9,
    'появление и исчезновение укладываются в критерий',
    `pollMs=${DEFAULT_CONFIG.live.pollMs} видна за ${appearMs.toFixed(0)} мс (порог 2000) исчезла за ${vanishMs.toFixed(0)} мс (порог 5000)`,
    emptyBefore === 0 && appeared && vanished && appearMs < 2_000 && vanishMs < 5_000,
  )

  if (aliveOnDisk.length === 0) {
    console.error(
      'нет живых сессий: проверки 1, 2 и 6 нечем проверять — запустите агента и повторите',
    )
    failed = true
  }
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)

interface SessionFile {
  pid: number
  sessionId: string
  entrypointRaw?: string
}

function sessionFiles(): SessionFile[] {
  const dir = join(claudeHome, 'sessions')
  if (!existsSync(dir)) return []
  const out: SessionFile[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
      const pid = typeof raw['pid'] === 'number' ? raw['pid'] : Number.parseInt(name, 10)
      const sessionId = raw['sessionId']
      if (!Number.isSafeInteger(pid) || typeof sessionId !== 'string') continue
      const file: SessionFile = { pid, sessionId }
      if (typeof raw['entrypoint'] === 'string' && raw['entrypoint'] !== '') {
        file.entrypointRaw = raw['entrypoint']
      }
      out.push(file)
    } catch {
      // Битый файл — забота парсера, не пробы.
    }
  }
  return out
}

function lines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
