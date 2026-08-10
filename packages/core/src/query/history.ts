/**
 * Вкладка «История» — неделя столбиками и хитмап «день × час» (4.6),
 * разделы 8 и 8б макета.
 *
 * Три вещи, которые надо помнить, читая код:
 *
 * 1. **Пустот здесь три, а не одна, и различить их можно только здесь.**
 *    «Час без расхода» — фон клетки, «день с нулём» — измеренный ноль,
 *    «день без данных» — день, которого индекс не покрывает. Схлопни второе с
 *    третьим — и суббота, в которую человек не работал, станет неотличима от
 *    воскресенья, которое ещё не наступило.
 * 2. **Час группируется по локальной метке, а не по абсолютному часу.** У зон
 *    со сдвигом в полчаса абсолютный час лежит в двух локальных, а на переводе
 *    часов один локальный час случается дважды — и это одна клетка, а не две.
 *    `strftime(… 'localtime')` отвечает на оба вопроса, арифметика по
 *    миллисекундам — ни на один.
 * 3. **День склеивается из часов, а не считается второй раз.** Иначе сумма
 *    столбика разошлась бы с суммой своей строки хитмапа, и оба числа остались
 *    бы настоящими по отдельности.
 */
import type { Db } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { dayRange } from './day.ts'
import type { DayRange } from './types.ts'

export interface HistoryHour {
  /** Час локального времени, 0–23. */
  hour: number
  tokens: number
  /**
   * Чей это час — провайдер, на который пришлось больше токенов. `null` —
   * расхода в этом часу не было. Судить обязан тот, кто видел обе суммы: у
   * клетки один цвет, и выбрать его в окне значит завести там второй счёт.
   */
  provider: Provider | null
}

export interface HistoryDay {
  /** Начало суток с учётом `ui.dayStartsAtHour`. */
  at: number
  /**
   * `null` — данных за этот день нет вовсе: он вне того, что покрывает индекс.
   * Ноль — измеренный ноль: день внутри наблюдаемого окна, и работы не было.
   */
  tokens: number | null
  /** Расход по провайдерам — куски столбика. Пусто при нуле и при `null`. */
  byProvider: Array<{ provider: Provider; tokens: number }>
  /** Двадцать четыре клетки. Пусто, если данных за день нет вовсе. */
  hours: HistoryHour[]
  /**
   * Число — нижняя граница, а не измерение: этих суток не достаёт лог Claude,
   * потому что Claude Code удалил его сам (`cleanupPeriodDays`). Показывается
   * знаком `≈`, как всякая оценка в продукте.
   */
  approximate: boolean
}

export interface HistoryReport {
  from: number
  to: number
  days: HistoryDay[]
  /** Итог периода — сумма дней, а не отдельный запрос. */
  total: number
  /** Первый день с расходом во всём индексе. `null` — индекс пуст. */
  firstDay: number | null
  /** Последний день с расходом. Вместе с первым задаёт наблюдаемое окно. */
  lastDay: number | null
  /** Сколько дней с расходом за всё время — «116 дней с расходом». */
  daysWithSpend: number
  /** Итог периода — нижняя граница: хоть у одних суток не достаёт логов. */
  approximate: boolean
  /**
   * С каких суток логи Claude на месте. `null` — Claude в индексе нет вовсе,
   * и говорить о его пропаже нечего. Раньше этой границы измеренного нуля не
   * бывает: сутки без расхода там `tokens === null`.
   */
  claudeFrom: number | null
}

interface HourRow {
  stamp: string
  provider: Provider
  tokens: number
}

/**
 * История за период.
 *
 * `now` приезжает параметром, а не берётся из часов: день после сегодняшнего
 * данных не имеет по другой причине, чем день до первого запуска, — но
 * показываются они одинаково, и обе причины должны быть видны из аргументов, а
 * не из момента вызова. Тесты на этом стоят целиком.
 */
export function historyReport(
  db: Db,
  range: DayRange,
  dayStartsAtHour: number,
  now: number,
): HistoryReport {
  const rows = db.all<HourRow>(
    `SELECT strftime('%Y-%m-%d %H', requests.ts / 1000, 'unixepoch', 'localtime') AS stamp,
            sessions.provider AS provider,
            sum(requests.context_tokens + requests.output) AS tokens
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE requests.ts >= ? AND requests.ts < ?
     GROUP BY stamp, provider`,
    range.from,
    range.to,
  )

  const byDay = new Map<number, HistoryDay>()
  // Кто сколько набрал в каждой клетке. Отдельно от `HistoryDay`, потому что
  // наружу едет один провайдер на клетку, а выбрать его можно только досчитав
  // обоих: пока час не кончился, «кого больше» — не вопрос, а догадка.
  const cellProviders = new Map<string, Map<Provider, number>>()
  for (const at of dayStarts(range, dayStartsAtHour)) {
    byDay.set(at, { at, tokens: 0, byProvider: [], hours: emptyHours(), approximate: false })
  }
  for (const row of rows) {
    const { at, hour } = placeHour(row.stamp, dayStartsAtHour)
    const day = byDay.get(at)
    if (day === undefined) continue
    const cell = day.hours[hour]!
    cell.tokens += row.tokens
    day.tokens = (day.tokens ?? 0) + row.tokens
    const own = day.byProvider.find((slice) => slice.provider === row.provider)
    if (own) own.tokens += row.tokens
    else day.byProvider.push({ provider: row.provider, tokens: row.tokens })
    const key = `${at} ${hour}`
    const owners = cellProviders.get(key) ?? new Map<Provider, number>()
    owners.set(row.provider, (owners.get(row.provider) ?? 0) + row.tokens)
    cellProviders.set(key, owners)
  }

  const span = observedSpan(db, dayStartsAtHour)
  const claudeFrom = claudeCoverage(db, dayStartsAtHour)
  for (const day of byDay.values()) {
    day.byProvider.sort((left, right) => right.tokens - left.tokens)
    if (!covered(day.at, span, now, dayStartsAtHour)) {
      day.tokens = null
      day.hours = []
      continue
    }
    if (claudeFrom === null || day.at >= claudeFrom) continue
    // Сутки внутри наблюдаемого окна, но лога Claude за них у нас нет — он был
    // и его удалили. Расход, который мы видим (Codex), настоящий, но неполный:
    // это нижняя граница. А сутки, где не видно ничего, — не измеренный ноль,
    // а незнание: измеренным нулём они объявляли бы «человек не работал» ровно
    // там, где мы просто не смотрели.
    if ((day.tokens ?? 0) > 0) day.approximate = true
    else {
      day.tokens = null
      day.hours = []
    }
  }
  // Цвет клетки — провайдер, набравший **в этом часу** больше. Считается после
  // сборки, а не по ходу: пока час не досчитан, «кого больше» неизвестно. И не
  // берётся у дня: день целиком может быть клодовым, а в конкретном часу
  // работал только Codex — клетка тогда покрасится чужим цветом.
  for (const day of byDay.values()) {
    for (const cell of day.hours) {
      if (cell.tokens === 0) continue
      cell.provider = dominant(cellProviders.get(`${day.at} ${cell.hour}`))
    }
  }

  const days = [...byDay.values()].sort((left, right) => left.at - right.at)
  return {
    from: range.from,
    to: range.to,
    days,
    total: days.reduce((sum, day) => sum + (day.tokens ?? 0), 0),
    firstDay: span.first,
    lastDay: span.last,
    daysWithSpend: span.count,
    approximate: days.some((day) => day.approximate),
    claudeFrom,
  }
}

/**
 * С каких суток логи Claude на месте.
 *
 * Claude Code чистит свои транскрипты сам (`cleanupPeriodDays`, по умолчанию 30
 * дней), и раньше этой границы утверждать «за эти сутки запросов не было»
 * нельзя: мы их логов не видели. Замер на живых логах — 92 дня внутри
 * покрытия, когда Claude Code точно работал (промпты в `~/.claude/history.jsonl`)
 * и индекс не знает о них ни одного запроса; 31 день из них показывался
 * измеренным нулём целиком.
 *
 * Правило именно про Claude, а не про всякого провайдера, у кого история
 * короче. Возьми мы «максимум по провайдерам», и человек, попробовавший Codex
 * сегодня, получил бы знак `≈` на всей своей клодовой истории — знак, который
 * стоит везде, не значит ничего (то же правило, что у порогов выделения в 3.4).
 * Codex своих роллаутов не удаляет: на живых логах они лежат с первого дня
 * наблюдения, 191 сутки против 54 у Claude на той же машине. Начнёт удалять —
 * это станет видно как `vanished_at` у его источников, и тогда правило
 * расширяется по измерению, а не по симметрии.
 */
function claudeCoverage(db: Db, dayStartsAtHour: number): number | null {
  const row = db.get<{ first: number | null }>(
    `SELECT min(requests.ts) AS first
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE sessions.provider = 'claude'`,
  )
  if (row?.first == null) return null
  return dayRange(row.first, dayStartsAtHour).from
}

/**
 * Провайдер клетки. Поровну — `null`, и клетка красится нейтральным: то же
 * правило, что у полосы проекта в 3.3, где `null` означает «чей это, сказать
 * нельзя», а не «ничей».
 */
function dominant(owners: Map<Provider, number> | undefined): Provider | null {
  if (owners === undefined) return null
  let best: Provider | null = null
  let seen = -1
  let tie = false
  for (const [provider, tokens] of owners) {
    if (tokens > seen) {
      best = provider
      seen = tokens
      tie = false
    } else if (tokens === seen) tie = true
  }
  return tie ? null : best
}

function emptyHours(): HistoryHour[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, provider: null }))
}

/** Начала суток внутри периода — календарно, как везде в продукте. */
function dayStarts(range: DayRange, dayStartsAtHour: number): number[] {
  const starts: number[] = []
  let at = dayRange(range.from, dayStartsAtHour).from
  while (at < range.to) {
    starts.push(at)
    at = dayRange(at, dayStartsAtHour, 1).from
  }
  return starts
}

/**
 * Куда попадает локальная метка `YYYY-MM-DD HH`.
 *
 * Час меньше начала дня принадлежит **предыдущим** суткам: при
 * `dayStartsAtHour = 4` запрос в 02:30 — это ещё вчерашняя ночь, и столбик у
 * него вчерашний.
 */
function placeHour(stamp: string, dayStartsAtHour: number): { at: number; hour: number } {
  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(5, 7))
  const date = Number(stamp.slice(8, 10))
  const hour = Number(stamp.slice(11, 13))
  const shift = hour < dayStartsAtHour ? -1 : 0
  const at = new Date(year, month - 1, date + shift, dayStartsAtHour, 0, 0, 0).getTime()
  return { at, hour }
}

interface Span {
  first: number | null
  last: number | null
  count: number
}

/** Какие сутки индекс вообще покрывает — по своим же запросам. */
function observedSpan(db: Db, dayStartsAtHour: number): Span {
  const row = db.get<{ first: number | null; last: number | null }>(
    'SELECT min(ts) AS first, max(ts) AS last FROM requests',
  )
  const days = db.all<{ stamp: string }>(
    `SELECT DISTINCT strftime('%Y-%m-%d %H', ts / 1000, 'unixepoch', 'localtime') AS stamp
     FROM requests`,
  )
  const unique = new Set(days.map(({ stamp }) => placeHour(stamp, dayStartsAtHour).at))
  return {
    first: row?.first == null ? null : dayRange(row.first, dayStartsAtHour).from,
    last: row?.last == null ? null : dayRange(row.last, dayStartsAtHour).from,
    count: unique.size,
  }
}

/**
 * Есть ли за эти сутки данные вообще.
 *
 * Внутри наблюдаемого окна ноль — измерение: мы читали логи этих суток и не
 * нашли ни одного запроса. Вне окна ноль — незнание: до первого запроса логов
 * не было, после сегодняшнего дня их ещё не будет. Разные слова, и различить
 * их больше негде.
 */
function covered(at: number, span: Span, now: number, dayStartsAtHour: number): boolean {
  if (span.first === null) return false
  const today = dayRange(now, dayStartsAtHour).from
  return at >= span.first && at <= today
}
