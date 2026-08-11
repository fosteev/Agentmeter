/**
 * Экран развёртки и советы по экономии (4.2, 4.3) на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/breakdown-live.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { IMAGE_ROW_KEY, ingestAll, openDb, type Db } from '../../packages/core/src/index.ts'
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

  // 8. Картинки отдельной статьёй (4.5) — и не поверх строк инструментов.
  //
  // Правило переписано здесь заново, прямым запросом к индексу: проба,
  // спрашивающая проверяемую функцию, чем ей следовало ответить, зелена при
  // любом ответе. Сумма вызовов по строкам обязана совпасть с числом вызовов в
  // индексе — задвоение поймается ровно здесь, потому что вырастет и она.
  const screen = buildSpendScreen(db, { scope: 'day', from: 0, to: Date.now() + 86_400_000 })
  const imageRow = screen.tools.find((row) => row.key === IMAGE_ROW_KEY)
  const counted = screen.tools.reduce((sum, row) => sum + row.calls, 0)
  const inIndex = db.get<{ total: number; images: number }>(
    `SELECT count(*) AS total, sum(CASE WHEN has_image = 1 THEN 1 ELSE 0 END) AS images
     FROM tool_calls`,
  )!
  const density = db.get<{ image: number; text: number }>(
    `SELECT
       round(avg(CASE WHEN has_image = 1 THEN result_bytes * 1.0 / marginal_tokens END), 1) AS image,
       round(avg(CASE WHEN has_image = 0 THEN result_bytes * 1.0 / marginal_tokens END), 1) AS text
     FROM tool_calls
     WHERE marginal_basis = 'measured' AND marginal_tokens > 100 AND result_bytes > 0`,
  )!
  report(
    8,
    'картинки своей строкой и не задвоены',
    `вызовов в индексе ${inIndex.total}, в строках ${counted}, с картинками ${inIndex.images} ` +
      `(в строке ${imageRow?.calls ?? 0}, ${imageRow?.label ?? '—'}), ` +
      `байт на токен: картинка ${density.image}, текст ${density.text}`,
    inIndex.images > 0 &&
      counted === inIndex.total &&
      imageRow !== undefined &&
      imageRow.calls === inIndex.images &&
      imageRow.label !== IMAGE_ROW_KEY,
  )

  // 9. Состав статей поимённо (4.9).
  //
  // Печатает настоящие имена с диска, а не «состав собран»: проба, сообщающая
  // о непустом списке, зелена и на списке из мусора. Заодно сторож на дрейф
  // формата листингов — каждый скилл, который в этих сессиях **звали**, обязан
  // найтись среди загруженных. Разойдись имена в листинге с именами в
  // `attributionSkill`, и колонка «использовано» считала бы одно, а подсказка
  // показывала другое.
  const composed = ['skills estimated', 'agents estimated', 'memory estimated', 'deferredTools estimated']
    .map((key) => screen.recurring.find((row) => row.key === key))
    .filter((row) => row !== undefined)
  const listed = composed.map(
    (row) =>
      `${row.label}: ${row.detail.names.length} имён из ${row.loaded ?? 0} штук` +
      `, назвали ${row.detail.sessions - row.detail.unnamed} сессий из ${row.detail.sessions}` +
      (row.detail.names[0] ? ` — ${row.detail.names.slice(0, 5).map((item) => item.name).join(', ')}` : ''),
  )
  const skillNames = new Set(
    (screen.recurring.find((row) => row.key === 'skills estimated')?.detail.names ?? []).map(
      (item) => item.name,
    ),
  )
  const invoked = db
    .all<{ skill: string }>(`SELECT DISTINCT skill FROM requests WHERE skill IS NOT NULL`)
    .map((row) => row.skill)
  const missing = invoked.filter((skill) => !skillNames.has(skill))
  report(
    9,
    'состав статей назван поимённо',
    `${listed.join(' · ')}; званных скиллов ${invoked.length}, не нашлось в листинге ${missing.length}` +
      (missing.length > 0 ? ` (${missing.slice(0, 5).join(', ')})` : ''),
    composed.length > 0 && skillNames.size > 0 && invoked.length > 0 && missing.length === 0,
  )

  // 10. Пустота, которую нельзя заполнить, названа словами, а не пустым списком.
  const speechless = screen.recurring.filter(
    (row) => row.detail.names.length === 0 && row.sources.length === 0,
  )
  const mute = speechless.filter((row) => row.detail.note === undefined)
  report(
    10,
    'статья без состава объясняется словами',
    `без состава ${speechless.length} (${speechless.map((row) => row.label).join(', ')}), молчащих ${mute.length}`,
    speechless.length > 0 && mute.length === 0,
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
