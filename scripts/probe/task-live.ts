/**
 * Карточка задачи на живых логах (3.4).
 *
 *     node --experimental-strip-types scripts/probe/task-live.ts
 *
 * Фикстуры показывают, что карточка собирается правильно; здесь проверяется,
 * что она собирается **на всём**, что лежит на диске. Две вещи иначе не видны
 * вовсе: сходимость шапки с таймлайном на сотнях задач (одна кривая сессия — и
 * сумма столбиков разойдётся с итогом) и мера выделения — сколько запросов
 * модель считает дорогими на настоящем расходе, а не на посеве.
 *
 * Каждая проверка названа поломкой, которую ловит.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  dayRange,
  defaultClaudeHome,
  defaultCodexHome,
  ingestAll,
  openDb,
  taskRows,
  todayReport,
} from '../../packages/core/src/index.ts'
import { buildTaskCard } from '../../apps/desktop/src/main/task.ts'
import type { TaskCard } from '../../packages/ipc/src/index.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-task-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const started = Date.now()
  const stats = ingestAll(db, { claudeHome: defaultClaudeHome(), codexHome: defaultCodexHome() })
  const config = DEFAULT_CONFIG
  // Карточки собираются по дням, а не за всю историю разом: окно спрашивает
  // ровно так — период карточки это период ленты, — и мерить надо то, что
  // делает приложение, а не то, что удобно пробе.
  const days = db
    .all<{ start: number }>(
      `SELECT min(ts) AS start FROM requests
        GROUP BY date(ts / 1000, 'unixepoch', 'localtime') ORDER BY start`,
    )
    .map((row) => dayRange(row.start, config.ui.dayStartsAtHour))
  const rows = days.flatMap((day) => taskRows(db, day).map((row) => ({ day, row })))
  report(
    1,
    'индекс собрался и задачи в нём есть',
    `sources=${stats.parsed} дней=${days.length} строк ленты=${rows.length} за ${((Date.now() - started) / 1000).toFixed(1)} с`,
    stats.parsed > 0 && rows.length > 0,
  )

  const build = Date.now()
  const cards: TaskCard[] = []
  for (const { day, row } of rows) {
    const card = buildTaskCard(db, { sessionId: row.sessionId, ...day }, config)
    if (card !== null) cards.push(card)
  }
  const perCard = (Date.now() - build) / Math.max(1, cards.length)
  report(
    2,
    'карточка собирается у каждой строки ленты и быстрее кадра',
    `собрано=${cards.length}/${rows.length} по ${perCard.toFixed(1)} мс`,
    cards.length === rows.length && perCard < 16,
  )

  // Ловит таймлайн и раскладку, собранные не по тому набору сессий: шапка
  // считает задачу деревом (сабагенты сведены в корень), и разойтись с ней
  // столбикам и вызовам нельзя ни на одной задаче из сотен.
  const broken = cards.filter(
    (card) =>
      card.timeline.length !== card.task.requests ||
      card.timeline.reduce((sum, point) => sum + point.tokens, 0) !== card.task.tokens.value ||
      card.tools.reduce((sum, tool) => sum + tool.calls, 0) !== card.task.toolCalls,
  )
  report(
    3,
    'шапка сходится с таймлайном и с инструментами на всех задачах',
    `расхождений=${broken.length} из ${cards.length}${broken[0] ? ` · первое ${broken[0].task.sessionId.slice(0, 8)}` : ''}`,
    broken.length === 0,
  )

  // Ловит долю дня, посчитанную не от суток: доли задач одного дня обязаны
  // сложиться в единицу, и проверяется это на самом плотном дне индекса.
  const busiest = db.get<{ day: number; total: number }>(
    `SELECT ts AS day, sum(input + output + cache_write + cache_read) AS total
       FROM requests GROUP BY date(ts / 1000, 'unixepoch', 'localtime')
      ORDER BY total DESC LIMIT 1`,
  )
  const day = dayRange(busiest?.day ?? Date.now(), config.ui.dayStartsAtHour)
  const dayCards = taskRows(db, day)
    .map((row) => buildTaskCard(db, { sessionId: row.sessionId, ...day }, config))
    .filter((card): card is TaskCard => card !== null)
  const shares = dayCards.reduce((sum, card) => sum + card.dayShare, 0)
  report(
    4,
    'доли задач самого плотного дня складываются в единицу',
    `задач=${dayCards.length} сумма долей=${shares.toFixed(6)} расход дня=${todayReport(db, day).totals?.total ?? 0}`,
    dayCards.length > 0 && Math.abs(shares - 1) < 1e-9,
  )

  // Ловит выделение, потерявшее меру: пометка обязана оставаться редкой. Пороги
  // подбирались на этих же логах, и если после правки модели помеченным
  // окажется каждый десятый запрос — красный столбик перестанет значить хоть
  // что-нибудь, а экран будет выглядеть работающим.
  const points = cards.reduce((sum, card) => sum + card.timeline.length, 0)
  const marked = cards.flatMap((card) => card.timeline.filter((point) => point.note !== undefined))
  const most = Math.max(
    0,
    ...cards.map((card) => card.timeline.filter((point) => point.note !== undefined).length),
  )
  const kinds = new Map<string, number>()
  for (const point of marked) {
    const kind = point.note!.split(' —')[0]!.replace(/^\d+ /, '')
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  report(
    5,
    'выделенных запросов немного, и у каждого названа причина',
    `${marked.length} из ${points} (${((marked.length / Math.max(1, points)) * 100).toFixed(2)}%), максимум на задачу=${most} · ${[...kinds].map(([kind, n]) => `${kind}: ${n}`).join(' · ')}`,
    marked.length > 0 && marked.length / Math.max(1, points) < 0.02 && most <= 10,
  )

  // Ловит фразу, собранную из пустого места: подпись есть ровно там, где есть
  // выделенные точки, а наблюдение про кэш — там, где кэш и правда съел задачу.
  const captions = cards.filter((card) => card.timelineNote !== undefined)
  const wrong = captions.filter(
    (card) => !card.timeline.some((point) => point.note !== undefined),
  )
  const notes = cards.filter((card) => card.note !== undefined)
  const advice = cards.filter((card) => card.note?.advice !== undefined)
  report(
    6,
    'подпись есть только при выделенных точках, совета нет до 4.3',
    `подписей=${captions.length} без выделенных=${wrong.length} наблюдений=${notes.length}/${cards.length} советов=${advice.length}`,
    wrong.length === 0 && advice.length === 0,
  )

  // Ловит список файлов, разошедшийся с самим собой: показанных путей не больше
  // четырёх, и каждый обязан быть внутри общего счёта.
  const files = cards.filter((card) => card.files !== undefined)
  const badFiles = files.filter(
    (card) => card.files!.paths.length > 4 || card.files!.paths.length > card.files!.total,
  )
  report(
    7,
    'файлов показано не больше четырёх, счёт — по всем',
    `задач с файлами=${files.length} нарушений=${badFiles.length} максимум файлов=${Math.max(0, ...files.map((card) => card.files!.total))}`,
    files.length > 0 && badFiles.length === 0,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
