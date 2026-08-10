/**
 * Экран развёртки и советы по экономии (4.2, 4.3) на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/breakdown-live.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ingestAll, openDb, type Db } from '../../packages/core/src/index.ts'
import { buildSpendScreen } from '../../apps/desktop/src/main/breakdown.ts'
import { buildDayReport } from '../../apps/desktop/src/main/day.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-breakdown-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  ingestAll(db)
  const days = daysWithSpend(db)
  const started = performance.now()
  const screens = days.map((range) => ({
    range,
    day: buildSpendScreen(db, { scope: 'day', ...range }),
    session: buildSpendScreen(db, { scope: 'session', ...range }),
  }))
  const ms = (performance.now() - started) / Math.max(1, screens.length * 2)

  const broken = screens.filter(
    ({ day }) =>
      day.split === undefined ||
      day.recurring.reduce((sum, row) => sum + row.period.value, 0) !==
        day.split.slices[0]!.tokens.value,
  ).length
  report(
    1,
    'статьи сходятся с полосой',
    `days=${screens.length} broken=${broken} собирается за ${ms.toFixed(1)} мс`,
    screens.length > 0 && broken === 0 && ms < 16,
  )

  const versus = screens.filter(
    ({ range, day }) =>
      JSON.stringify(day.split) !== JSON.stringify(buildDayReport(db, range).split),
  ).length
  report(
    2,
    'полоса та же, что на вкладке «Сегодня»',
    `days=${screens.length} broken=${versus}`,
    versus === 0,
  )

  const scoped = screens.filter(
    ({ day, session }) =>
      day.sessions > 0 &&
      session.split!.slices[0]!.tokens.value !==
        Math.round(day.split!.slices[0]!.tokens.value / day.sessions),
  ).length
  report(
    3,
    '«за сессию» делит одним знаменателем',
    `days=${screens.length} broken=${scoped}`,
    scoped === 0,
  )

  const rows = screens.flatMap(({ day }) => day.recurring)
  const impossible = rows.filter(
    (row) => row.loaded !== null && row.used !== null && row.used > row.loaded,
  )
  const listings = rows.filter((row) => row.key === 'skills estimated' || row.key === 'agents estimated')
  const withCount = listings.filter((row) => row.loaded !== null)
  report(
    4,
    'использованного не больше загруженного',
    `rows=${rows.length} нарушений=${impossible.length}; листингов ${withCount.length} из ${listings.length} распознано`,
    impossible.length === 0 && withCount.length > 0,
  )

  const all = buildSpendScreen(db, {
    scope: 'day',
    from: 0,
    to: Date.parse('2030-01-01T00:00:00.000Z'),
  })
  const servers = all.recurring.find((row) => row.key === 'mcpTools estimated')?.sources ?? []
  const idle = servers.filter((source) => source.calls === 0)
  const wasted = idle.reduce((sum, source) => sum + source.period.value, 0)
  report(
    5,
    'сервер без вызовов виден и посчитан',
    `серверов ${servers.length}, ни разу не звали ${idle.length}, на них ${format(wasted)} токенов` +
      (idle[0] ? ` (дороже всех ${idle[0].source}: ${format(idle[0].period.value)}, тулов ${idle[0].loaded})` : ''),
    servers.length > 0 && idle.length > 0,
  )

  const advice = all.advice ?? []
  const called = new Set(
    (all.recurring.find((row) => row.key === 'mcpTools estimated')?.sources ?? [])
      .filter((source) => source.calls > 0)
      .map((source) => source.source),
  )
  const wrong = advice.filter((row) => called.has(row.source)).length
  const silent = advice.length < idle.length && advice.at(-1)?.hidden === undefined
  report(
    6,
    'совет про неиспользованное и без молчаливой обрезки',
    `советов ${advice.length} из ${idle.length}, про использованное ${wrong}, скрыто ${advice.at(-1)?.hidden ?? 0}` +
      (advice[0] ? `; первый — «${advice[0].headline}»` : ''),
    advice.length > 0 && wrong === 0 && !silent,
  )

  const negative = rows.filter((row) => row.period.value < 0 || row.perSession.value < 0).length
  const noLabel = rows.filter((row) => row.label.length === 0).length
  report(
    7,
    'строки называются и не уходят в минус',
    `rows=${rows.length} безымянных=${noLabel} отрицательных=${negative}`,
    noLabel === 0 && negative === 0,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exit(1)

function daysWithSpend(db: Db): Array<{ from: number; to: number }> {
  const rows = db.all<{ day: string }>(
    `SELECT DISTINCT date(requests.ts / 1000, 'unixepoch', 'localtime') AS day FROM requests`,
  )
  return rows.map(({ day }) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number]
    return {
      from: new Date(year, month - 1, date).getTime(),
      to: new Date(year, month - 1, date + 1).getTime(),
    }
  })
}

function format(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
