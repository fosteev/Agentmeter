/**
 * Пересборка кэша и переплата за паузу (4.4) на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/cache-live.ts
 *
 * Модель — [`docs/roadmap/4.4-cache.md`](../../docs/roadmap/4.4-cache.md).
 * Шесть проверок; проверка 3 сверяется с **записями провайдера** в самих
 * транскриптах, а не со своим же выводом: правило, спрашивающее проверяемую
 * функцию, чем ей следовало ответить, зелено при любом ответе.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CACHE_TTL_1H,
  CACHE_TTL_5M,
  cacheRebuilds,
  ingestAll,
  openDb,
  todayReport,
  type Db,
} from '../../packages/core/src/index.ts'

const DAY = 24 * 60 * 60 * 1000

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-cache-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const ingest = ingestAll(db)
  const days = daysWithSpend(db)
  const all = cacheRebuilds(db, { range: { from: 0, to: Date.now() + DAY } })

  // 1. Цепочка кэша цела. Превышение означает незаписанный запрос, и 1.3 обязан
  //    был восстановить его: недобор, посчитанный от неверного предыдущего, —
  //    это пересборка, которой не было.
  const surplus = chainSurplus(db)
  report(
    1,
    'цепочка кэша цела',
    `переходов ${surplus.transitions}, превышений ${surplus.surplus}, точных ${surplus.exact}, разрывов ${surplus.deficit}, ingest failed=${ingest.failed}`,
    surplus.transitions > 0 && surplus.surplus === 0 && ingest.failed === 0,
  )

  // 2. Четыре причины покрывают всё и не пересекаются.
  const counts =
    all.start.count + all.pause.count + all.early.count + all.compact.count
  const tokens = all.start.tokens + all.pause.tokens + all.early.tokens + all.compact.tokens
  const bucketed = all.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  report(
    2,
    'причины складываются в итог',
    `старт ${all.start.count}/${mega(all.start.tokens)} пауза ${all.pause.count}/${mega(all.pause.tokens)} ` +
      `раньше срока ${all.early.count}/${mega(all.early.tokens)} компакт ${all.compact.count}/${mega(all.compact.tokens)} ` +
      `= ${all.total.count}/${mega(all.total.tokens)}, в корзинах ${bucketed}`,
    all.total.count > 0 &&
      counts === all.total.count &&
      tokens === all.total.tokens &&
      bucketed === all.pause.count,
  )

  // 3. Компакт назван компактом — сверка с записями провайдера, а не с собой.
  const marked = compactMarkers()
  const found = all.events.filter((event) => event.cause === 'compact')
  const matched = found.filter((event) =>
    marked.some((mark) => Math.abs(mark - event.ts) < 15 * 60_000),
  ).length
  report(
    3,
    'компакт подтверждён записью провайдера',
    `записей compact_boundary в логах ${marked.length}, событий-компактов ${found.length}, совпало ${matched}`,
    marked.length > 0 && found.length === matched,
  )

  // 4. Срок берётся из лога. У события в корзине пауз он обязан быть известен и
  //    быть одним из двух сроков, которые провайдер вообще пишет.
  const paused = all.events.filter((event) => event.cause === 'pause')
  const known = paused.filter(
    (event) => event.ttlMs === CACHE_TTL_1H || event.ttlMs === CACHE_TTL_5M,
  ).length
  const shorter = paused.filter((event) => (event.pauseMs ?? 0) < (event.ttlMs ?? 0)).length
  report(
    4,
    'срок жизни кэша из лога',
    `пауз ${paused.length}, срок известен у ${known}, короче срока ${shorter}, ` +
      `подпись блока ${all.ttlMs / 60_000} мин`,
    paused.length > 0 && known === paused.length && shorter === 0,
  )

  // 5. Итог дня не зависит от пересборок. Свойство § 5 модели: тот же промпт
  //    едет либо чтением, либо записью, и `Σ (ctx + output)` от этого не
  //    меняется. Значит блок — часть шапки, а не слагаемое к ней.
  const overflow = days.filter((range) => {
    const report_ = cacheRebuilds(db, { range })
    const total = todayReport(db, range).totals?.total ?? 0
    return report_.total.tokens > total
  }).length
  report(
    5,
    'пересборки лежат внутри итога дня',
    `дней ${days.length}, где блок больше шапки ${overflow}`,
    days.length > 0 && overflow === 0,
  )

  // 6. Сужение доезжает, и у Codex блока нет вовсе.
  const claude = cacheRebuilds(db, {
    range: { from: 0, to: Date.now() + DAY },
    scope: { provider: 'claude' },
  })
  const codex = cacheRebuilds(db, {
    range: { from: 0, to: Date.now() + DAY },
    scope: { provider: 'codex' },
  })
  const codexWrites = db.get<{ count: number }>(
    `SELECT count(*) AS count FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE sessions.provider = 'codex' AND requests.cache_write > 0`,
  )!
  report(
    6,
    'сужение доезжает, у Codex мерить нечем',
    `claude ${claude.total.count} == всего ${all.total.count}, codex measurable=${codex.measurable}, ` +
      `запросов Codex с записью в кэш ${codexWrites.count}`,
    claude.total.count === all.total.count &&
      codex.measurable === false &&
      codexWrites.count === 0,
  )

  // Для сведения, без порога: распределение, ради которого этап и переписал
  // premise макета про пять минут.
  const byBucket = all.buckets
    .map((bucket) => `${Math.round(bucket.fromMs / 60_000)}м+ ×${bucket.count}`)
    .join(', ')
  console.log(`  корзины пауз: ${byBucket || 'нет'}`)
  console.log(
    `  срок записи: 1h ${mega(sumWrites(db, 'cache_write_1h'))}, 5m ${mega(sumWrites(db, 'cache_write_5m'))}`,
  )
  if (all.worst?.pauseMs != null) {
    console.log(
      `  самая дорогая пауза: ${Math.round(all.worst.pauseMs / 60_000)} мин, ${mega(all.worst.tokens)}, ${all.worst.project}`,
    )
  }
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

/**
 * Цепочка кэша по всем сессиям Claude.
 *
 * Правило переписано здесь заново, а не взято у `cacheRebuilds`: проба,
 * спрашивающая проверяемую функцию, чем ей следовало ответить, зелена при любом
 * ответе.
 */
function chainSurplus(db: Db): {
  transitions: number
  exact: number
  deficit: number
  surplus: number
} {
  const rows = db.all<{
    session_id: string
    seq: number
    cache_write: number
    cache_read: number
  }>(
    `SELECT requests.session_id, requests.seq, requests.cache_write, requests.cache_read
     FROM requests JOIN sessions ON sessions.id = requests.session_id
     WHERE sessions.provider = 'claude'
     ORDER BY requests.session_id, requests.seq`,
  )
  let transitions = 0
  let exact = 0
  let deficit = 0
  let surplus = 0
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!
    const current = rows[index]!
    if (previous.session_id !== current.session_id) continue
    transitions += 1
    const expected = previous.cache_read + previous.cache_write
    if (current.cache_read === expected) exact += 1
    else if (current.cache_read < expected) deficit += 1
    else surplus += 1
  }
  return { transitions, exact, deficit, surplus }
}

/** Метки времени всех записей `compact_boundary` в транскриптах на диске. */
function compactMarkers(): number[] {
  const rows = db.all<{ source_path: string }>(
    `SELECT DISTINCT source_path FROM sessions WHERE provider = 'claude'`,
  )
  const stamps: number[] = []
  for (const { source_path } of rows) {
    if (!existsSync(source_path)) continue
    const text = readFileSync(source_path, 'utf8')
    if (!text.includes('compact_boundary') && !text.includes('isCompactSummary')) continue
    for (const line of text.split('\n')) {
      if (!line.includes('compact_boundary') && !line.includes('isCompactSummary')) continue
      try {
        const record = JSON.parse(line) as {
          subtype?: string
          isCompactSummary?: boolean
          timestamp?: string
        }
        if (record.subtype === 'compact_boundary' || record.isCompactSummary === true) {
          const at = Date.parse(record.timestamp ?? '')
          if (Number.isFinite(at)) stamps.push(at)
        }
      } catch {
        // Битая строка — забота doctor (1.4), не эта проба.
      }
    }
  }
  return stamps
}

function sumWrites(db: Db, column: 'cache_write_1h' | 'cache_write_5m'): number {
  return db.get<{ total: number }>(`SELECT coalesce(sum(${column}), 0) AS total FROM requests`)!
    .total
}

function mega(value: number): string {
  return `${(value / 1e6).toFixed(2)}M`
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
