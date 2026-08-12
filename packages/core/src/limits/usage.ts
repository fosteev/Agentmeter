/**
 * Настоящие лимиты Claude: журнал снимков `statusLine` и калибровка веса
 * `cache_read` (1.9).
 *
 * В логах Claude нет ни процента лимита, ни потолка окна, ни веса чтения кэша —
 * и разница между «считать чтение кэша» и «не считать» два порядка (339M против
 * 4.3M за сутки). Зато Claude Code сам отдаёт эти числа: не в транскрипт, а на
 * stdin команде `statusLine`, ключом `rate_limits` (замерено на 2.1.85,
 * 11 августа 2026). Ни сети, ни чужих токенов это не требует — тем и выбрано.
 *
 * Здесь три вещи и ни одной больше: разбор того JSON, журнал наблюдений и
 * решение линейной системы по нему. Подгонки коэффициента нет и быть не должно:
 * пока точек мало или модель не сходится, наружу уходит `null`, и лимиты
 * остаются помеченными оценкой. Придуманное правдоподобное число здесь — это
 * враньё в единственном месте, где продукт обязан быть точным.
 *
 * **Единицы.** В журнал `resetsAt` пишется в **миллисекундах**, хотя на stdin
 * приезжают секунды. Причина не в красоте: `resetsAt` в
 * [`LimitWindow`](../sources/types.ts) — миллисекунды, и второе поле того же
 * имени в соседнем файле, но в секундах, однажды сложится с первым. Перевод
 * секунд в миллисекунды делает `parseStatusLine`, он же единственное место,
 * которое видит исходный формат.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LimitRequest } from './claude.ts'

/** Окна, которые отдаёт statusLine. `seven_day` у нас зовётся `weekly` — как в `LimitWindow`. */
export type UsageWindowKind = 'fiveHour' | 'weekly'

const MINUTE_MS = 60_000
const WINDOW_MINUTES: Record<UsageWindowKind, number> = { fiveHour: 300, weekly: 10_080 }
const KINDS: readonly UsageWindowKind[] = ['fiveHour', 'weekly']

/** Одно окно в снимке: процент и момент сброса. */
export interface UsageWindowSample {
  /** Процент окна. Дробный: наблюдалось `14.000000000000002`. */
  pct: number
  /** Конец окна, миллисекунды (на stdin — секунды, см. шапку). */
  resetsAt: number
}

/** Строка журнала `usage.jsonl`. */
export interface UsageSnapshot {
  /** Когда снимок записан приложением, мс. */
  ts: number
  sessionId: string
  /**
   * Откуда снимок (6.3). Отсутствие поля читается как `statusline`: журнал
   * старше второго источника, и переписывать накопленное ради нового поля
   * значит потерять точки, которых больше неоткуда взять.
   *
   * Различать источники приходится не из любви к учёту: у строки состояния
   * проценты дробные, у `/api/oauth/usage` — целые, и одна точка с
   * квантованием способна заблокировать всю калибровку (`minIntegerPct`).
   */
  source?: 'statusline' | 'oauth'
  cliVersion?: string
  /**
   * Размер контекстного окна из того же JSON. Пишется сразу и не применяется
   * здесь: знаменатель контекста у Claude — пункт 12 CLAUDE.md и отдельная
   * строка роадмапа, а не побочный эффект калибровки лимитов.
   */
  contextWindowSize?: number
  fiveHour?: UsageWindowSample
  weekly?: UsageWindowSample
}

/**
 * JSON со stdin `statusLine` → строка журнала.
 *
 * `null` означает «записывать нечего», а не ошибку: ключа `rate_limits` в
 * объекте нет вовсе, пока в сессии не прошёл первый запрос к API, и таких
 * вызовов в начале каждой сессии несколько. Запись без единого окна журналу
 * не нужна — калибровать по ней нечего, а дедуп её не отсеет, и файл рос бы
 * на каждый вызов хука.
 */
export function parseStatusLine(raw: unknown, ts: number): UsageSnapshot | null {
  if (!isObject(raw)) return null
  const limits = raw['rate_limits']
  if (!isObject(limits)) return null

  const fiveHour = windowSample(limits['five_hour'])
  const weekly = windowSample(limits['seven_day'])
  if (!fiveHour && !weekly) return null

  const snapshot: UsageSnapshot = { ts, sessionId: text(raw['session_id']) ?? '' }
  const version = text(raw['version'])
  if (version !== undefined) snapshot.cliVersion = version
  const context = isObject(raw['context_window'])
    ? finite(raw['context_window']['context_window_size'])
    : undefined
  if (context !== undefined && context > 0) snapshot.contextWindowSize = context
  if (fiveHour) snapshot.fiveHour = fiveHour
  if (weekly) snapshot.weekly = weekly
  return snapshot
}

function windowSample(raw: unknown): UsageWindowSample | undefined {
  if (!isObject(raw)) return undefined
  const pct = finite(raw['used_percentage'])
  const resetsAt = finite(raw['resets_at'])
  if (pct === undefined || pct < 0 || resetsAt === undefined || resetsAt <= 0) return undefined
  return { pct, resetsAt: Math.round(resetsAt * 1000) }
}

/**
 * Ключи наблюдения — пара (процент, момент сброса) каждого окна.
 *
 * Дедуп идёт по ним: хук зовётся на каждую отрисовку строки состояния и из
 * нескольких окон сразу, то есть десятки раз на одно и то же наблюдение.
 * Запись попадает в журнал, если **хоть один** её ключ новый: окна сбрасываются
 * порознь, и недельное, повторяющееся часами, не должно глушить пятичасовое.
 */
export function usageKeys(snapshot: UsageSnapshot): string[] {
  const keys: string[] = []
  for (const kind of KINDS) {
    const sample = snapshot[kind]
    if (sample) keys.push(`${kind}:${sample.pct}:${sample.resetsAt}`)
  }
  return keys
}

export function readUsageJournal(path: string): UsageSnapshot[] {
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: UsageSnapshot[] = []
  for (const line of text.split('\n')) {
    const record = parseJournalLine(line)
    if (record) out.push(record)
  }
  return out
}

export function appendUsageJournal(path: string, records: readonly UsageSnapshot[]): void {
  if (records.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8')
}

function parseJournalLine(line: string): UsageSnapshot | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const raw: unknown = JSON.parse(trimmed)
    if (!isObject(raw)) return undefined
    const ts = finite(raw['ts'])
    if (ts === undefined) return undefined
    const snapshot: UsageSnapshot = { ts, sessionId: text(raw['sessionId']) ?? '' }
    if (raw['source'] === 'oauth' || raw['source'] === 'statusline') snapshot.source = raw['source']
    const version = text(raw['cliVersion'])
    if (version !== undefined) snapshot.cliVersion = version
    const context = finite(raw['contextWindowSize'])
    if (context !== undefined) snapshot.contextWindowSize = context
    for (const kind of KINDS) {
      const sample = journalSample(raw[kind])
      if (sample) snapshot[kind] = sample
    }
    return snapshot
  } catch {
    // Оборванная строка — потеря одного наблюдения. Ронять из-за неё журнал,
    // который копится днями и второй копии не имеет, нельзя (так же в
    // `live/lifetimes.ts`).
    return undefined
  }
}

function journalSample(raw: unknown): UsageWindowSample | undefined {
  if (!isObject(raw)) return undefined
  const pct = finite(raw['pct'])
  const resetsAt = finite(raw['resetsAt'])
  if (pct === undefined || pct < 0 || resetsAt === undefined || resetsAt <= 0) return undefined
  return { pct, resetsAt }
}

/**
 * Пороги, при которых калибровка считается состоявшейся.
 *
 * Лежат одним объектом, потому что их печатает проба: число, зашитое в условие
 * и пересказанное в выводе своими словами, разъезжается с условием на первой же
 * правке. Откуда каждое — в `docs/roadmap/1.9-usage.md`, раздел «Критерий
 * готовности».
 */
export const CALIBRATION = {
  /** Точек в выборке пятичасовых окон. */
  minPoints: 20,
  /** Разных пятичасовых окон: одно окно — это один день одного человека. */
  minWindows: 3,
  /** Разброс потолков, подразумеваемых разными окнами. */
  maxCapSpread: 0.05,
  /** Медианное отклонение предсказанного процента от наблюдаемого, п.п. */
  maxResidualPp: 2,
  /** Насколько весам пятичасового и недельного окна позволено разойтись. */
  maxWeightGap: 0.05,
  /**
   * Размах доли чтения кэша по точкам. Меньше — вес и потолок неразделимы: обе
   * колонки системы растут вместе, и решение уедет в шум, оставшись правдоподобным.
   */
  minShareSpread: 0.05,
  /**
   * Насколько окно вправе разойтись с остальными по подразумеваемому потолку,
   * прежде чем считаться наблюдением о чём-то другом (пункт 1 подводных камней:
   * расход с другой машины поднимает процент, следа у нас не оставляя).
   */
  maxCapDeviation: 0.2,
  /**
   * Прирост процента без единого нашего запроса, после которого интервал
   * считается чужим расходом, — **долей от уже накопленного в окне процента**.
   *
   * Нулём этот порог быть не может, и это не осторожность. Часть расхода в
   * логах не лежит принципиально: служебный Haiku в транскрипт не пишется вовсе
   * (1.30% на эталоне, пункт 20 CLAUDE.md), хвостовые прогревы — тоже (≤ 3.3%,
   * 1.3). Порог ноль объявил бы чужой машиной каждую заглавную строку сессии.
   * 5% — сумма обеих измеренных систематик.
   *
   * Долей, а не пунктами: одна и та же чужая тысяча токенов сдвигает
   * пятичасовое окно в двадцать раз сильнее недельного, и порог в п.п. был бы
   * либо слеп к недельному, либо истеричен к пятичасовому.
   */
  foreignShare: 0.05,
  /**
   * Пол того же порога, п.п. В начале окна накопленный процент близок к нулю, и
   * доля от него ловила бы округление.
   */
  foreignFloorPp: 1,
  /**
   * Наименьший процент, при котором берётся снимок из `/api/oauth/usage` (6.3).
   *
   * Этот источник отдаёт **целые** проценты — `19`, а не `19.0000001`, — то
   * есть каждая его точка несёт квантование до ±0.5 п.п. При `p = 50` это 1%
   * относительной ошибки, при `p = 5` — уже 10%, и такая точка не столько
   * добавляет знание, сколько тянет решение на себя.
   *
   * Десятка здесь не круглое число из головы, а замер: в
   * `fixtures/usage/expected-oauth.json` одна точка с истинными 5.4%,
   * приехавшая пятёркой, разводит потолки соседних окон на **7.66%** при
   * пороге 5% — то есть калибровка не теряет точность, а не состоится вовсе.
   *
   * Дробных снимков (`statusline`) порог не касается: у них квантования нет.
   */
  minIntegerPct: 10,
} as const

/** Точка выборки: наблюдённый процент против нашей суммы внутри того же окна. */
export interface UsagePoint {
  kind: UsageWindowKind
  /** Ключ окна — его момент сброса. */
  resetsAt: number
  ts: number
  pct: number
  /** `input + cacheWrite + output` — то, что весит единицу при любом весе. */
  plain: number
  cacheRead: number
}

export interface DroppedWindow {
  kind: UsageWindowKind
  resetsAt: number
  /**
   * `foreign` — процент вырос, а запросов у нас нет вовсе: работа с другой
   * машины, из веба или из Claude Desktop. `cap-outlier` — прирост несопоставим
   * с остальными окнами.
   */
  reason: 'foreign' | 'cap-outlier'
  /** Сколько точек ушло вместе с ним. */
  points: number
}

export interface Fit {
  kind: UsageWindowKind
  points: number
  windows: number
  cap: number | null
  weight: number | null
  /** Медиана |предсказанный процент − наблюдённый|, п.п. */
  residualPp: number | null
  /** Разброс подразумеваемых потолков между окнами, доля от медианы. */
  capSpread: number | null
  /** Размах доли чтения кэша по точкам. */
  shareSpread: number
  /** Почему решения нет. Отсутствует, когда оно есть. */
  reason?: 'no-points' | 'flat-share' | 'degenerate' | 'out-of-range'
  /**
   * Решение, которое система выдала и которое пришлось отвергнуть, — только при
   * `out-of-range`. Держится ради пробы: «вес вышел 1.8» это разговор про
   * модель, а голое «out-of-range» — про то, что что-то не так.
   */
  rejected?: { cap: number; weight: number }
}

export type CalibrationBlocker =
  'few-points' | 'few-windows' | 'no-fit' | 'weight-disagrees' | 'cap-spread' | 'residual'

export interface Calibration {
  fiveHour: Fit
  weekly: Fit
  /** Что выброшено из выборки и почему. */
  dropped: DroppedWindow[]
  /** |w пятичасового − w недельного|. Потолки у них разные, вес обязан совпасть. */
  weightGap: number | null
  /** Пусто — сошлось всё. */
  blockers: CalibrationBlocker[]
  ok: boolean
  /**
   * Что писать в конфиг. Всё `null`, пока `ok === false`: «данных мало» —
   * нормальный исход, а не повод подставить правдоподобное.
   */
  cacheReadWeight: number | null
  fiveHourCap: number | null
  weeklyCap: number | null
}

/**
 * Снимки + запросы Claude → вес чтения кэша и потолки окон.
 *
 * Модель: для снимка с процентом `p` и границей `resetsAt` берётся окно
 * `[resetsAt − длина, resetsAt)`, внутри него до момента снимка суммируются
 * наши запросы, и тогда `p/100 · cap = I + W + O + w · R`. Неизвестных две, и
 * по ним это линейно: `(p/100)·cap − R·w = I + W + O`. Две точки задают
 * решение, больше — МНК.
 *
 * Пятичасовые и недельные окна решаются **порознь**: потолок у них разный, а
 * вес обязан совпасть — это и есть проверка модели. Совпал — наружу уходит вес
 * пятичасовых окон, их больше и они короче; разошёлся — не уходит ничего.
 */
export function calibrate(
  snapshots: readonly UsageSnapshot[],
  requests: readonly LimitRequest[],
): Calibration {
  const totals = prefixTotals(requests)
  const dropped: DroppedWindow[] = []
  const fits: Record<UsageWindowKind, Fit> = {
    fiveHour: emptyFit('fiveHour'),
    weekly: emptyFit('weekly'),
  }

  for (const kind of KINDS) {
    const points = buildPoints(snapshots, kind, totals, dropped)
    // Отсев окон идёт **до** общего решения, а не после него: одно окно с
    // чужим расходом уводит общее решение за пределы доли, и отсев, стоящий
    // после, не запускается вовсе — проверено, вес выходил −0.17.
    const outliers = capOutliers(points, kind)
    for (const window of outliers) dropped.push(window)
    const rejected = new Set(outliers.map((window) => window.resetsAt))
    fits[kind] = solve(
      outliers.length === 0 ? points : points.filter((point) => !rejected.has(point.resetsAt)),
      kind,
    )
  }

  const weightGap =
    fits.fiveHour.weight === null || fits.weekly.weight === null
      ? null
      : Math.abs(fits.fiveHour.weight - fits.weekly.weight)

  const blockers: CalibrationBlocker[] = []
  if (fits.fiveHour.points < CALIBRATION.minPoints) blockers.push('few-points')
  if (fits.fiveHour.windows < CALIBRATION.minWindows) blockers.push('few-windows')
  if (fits.fiveHour.weight === null || fits.weekly.weight === null) blockers.push('no-fit')
  if (weightGap !== null && weightGap > CALIBRATION.maxWeightGap) blockers.push('weight-disagrees')
  if ((fits.fiveHour.capSpread ?? 0) > CALIBRATION.maxCapSpread) blockers.push('cap-spread')
  if ((fits.fiveHour.residualPp ?? 0) > CALIBRATION.maxResidualPp) blockers.push('residual')

  const ok = blockers.length === 0
  return {
    fiveHour: fits.fiveHour,
    weekly: fits.weekly,
    dropped,
    weightGap,
    blockers,
    ok,
    cacheReadWeight: ok ? fits.fiveHour.weight : null,
    fiveHourCap: ok ? fits.fiveHour.cap : null,
    weeklyCap: ok ? fits.weekly.cap : null,
  }
}

/**
 * Снимки одного вида окна → точки выборки.
 *
 * Здесь же оба структурных отсева, и оба — не про статистику, а про то, что
 * наблюдение означает.
 *
 * **Отставший снимок.** Процент приезжает из ответа API и при параллельных
 * запросах отстаёт (1.8: 57% → 1% и обратно за 13 секунд). Отставший снимок
 * даёт заниженный процент против полной нашей суммы, то есть завышенный
 * потолок. Поэтому внутри окна берутся только те снимки, что ставят новый
 * максимум, — правило 1.8 «процент окна это максимум наблюдений».
 *
 * **Чужой расход.** Процент считается по аккаунту, а не по машине: работа с
 * другого компьютера, из веба или из Claude Desktop поднимает его, не оставляя
 * следа у нас. Видно это по интервалу, где процент вырос, а наших запросов нет
 * ни одного. Заражение действует **вперёд**: все последующие проценты этого
 * окна смещены на чужой расход, а предыдущие — нет, поэтому окно обрезается с
 * точки заражения, а не выбрасывается целиком. Для пятичасового окна, где чужое
 * пришло первым, это и есть «выбросить целиком», а недельное, внутри которого
 * такое случилось под конец, сохраняет всё, что было до.
 */
function buildPoints(
  snapshots: readonly UsageSnapshot[],
  kind: UsageWindowKind,
  totals: PrefixTotals,
  dropped: DroppedWindow[],
): UsagePoint[] {
  const windowMs = WINDOW_MINUTES[kind] * MINUTE_MS
  const byWindow = new Map<number, UsagePoint[]>()

  for (const snapshot of [...snapshots].sort((left, right) => left.ts - right.ts)) {
    const sample = snapshot[kind]
    if (!sample || sample.pct <= 0) continue
    // Целочисленный источник на малом проценте: см. `minIntegerPct`. Точка не
    // отбрасывается как чужая и не попадает в `dropped` — она просто не
    // наблюдение, а округление, и объяснять её человеку нечем.
    if (snapshot.source === 'oauth' && sample.pct < CALIBRATION.minIntegerPct) continue
    const startsAt = sample.resetsAt - windowMs
    const spend = totals.between(startsAt, snapshot.ts)
    const point: UsagePoint = {
      kind,
      resetsAt: sample.resetsAt,
      ts: snapshot.ts,
      pct: sample.pct,
      plain: spend.plain,
      cacheRead: spend.cacheRead,
    }
    byWindow.set(sample.resetsAt, [...(byWindow.get(sample.resetsAt) ?? []), point])
  }

  const out: UsagePoint[] = []
  for (const [resetsAt, all] of byWindow) {
    const sorted = [...all].sort((left, right) => left.ts - right.ts)
    // Начало окна — точка отсчёта: процент там ноль, наш расход тоже. Без неё
    // первый снимок окна не с чем сравнить, а чужой расход, пришедший до него,
    // — самый частый случай из всех.
    let previousPct = 0
    let previousSpend = 0
    let maximum = 0
    const kept: UsagePoint[] = []
    let infected = false
    for (const point of sorted) {
      if (point.pct <= maximum) continue
      maximum = point.pct
      const spend = point.plain + point.cacheRead
      const allowed = Math.max(CALIBRATION.foreignFloorPp, CALIBRATION.foreignShare * previousPct)
      if (spend === previousSpend && point.pct - previousPct > allowed) {
        infected = true
        break
      }
      previousPct = point.pct
      previousSpend = spend
      kept.push(point)
    }
    if (infected) {
      dropped.push({ kind, resetsAt, reason: 'foreign', points: sorted.length - kept.length })
    }
    out.push(...kept)
  }
  return out.sort((left, right) => left.ts - right.ts)
}

/**
 * МНК по двум неизвестным.
 *
 * Считается в миллионах токенов: в штуках колонка `R` порядка `10^7` соседствует
 * с колонкой `p/100` порядка `10^-1`, и нормальные уравнения теряют разряды на
 * ровном месте.
 */
function solve(points: readonly UsagePoint[], kind: UsageWindowKind): Fit {
  const windows = new Set(points.map((point) => point.resetsAt)).size
  const shares = points.map((point) =>
    point.plain + point.cacheRead === 0 ? 0 : point.cacheRead / (point.plain + point.cacheRead),
  )
  const shareSpread = shares.length === 0 ? 0 : Math.max(...shares) - Math.min(...shares)
  const base: Fit = {
    kind,
    points: points.length,
    windows,
    cap: null,
    weight: null,
    residualPp: null,
    capSpread: null,
    shareSpread,
  }

  if (points.length < 2) return { ...base, reason: 'no-points' }
  // Одинаковая доля чтения кэша во всех точках означает, что колонки системы
  // пропорциональны: решение формально существует, а держится на шуме.
  if (shareSpread < CALIBRATION.minShareSpread) return { ...base, reason: 'flat-share' }

  const M = 1_000_000
  let aa = 0
  let ab = 0
  let bb = 0
  let ac = 0
  let bc = 0
  for (const point of points) {
    const a = point.pct / 100
    const b = -point.cacheRead / M
    const c = point.plain / M
    aa += a * a
    ab += a * b
    bb += b * b
    ac += a * c
    bc += b * c
  }
  const det = aa * bb - ab * ab
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return { ...base, reason: 'degenerate' }

  const cap = ((bb * ac - ab * bc) / det) * M
  const weight = (aa * bc - ab * ac) / det
  if (!Number.isFinite(cap) || !Number.isFinite(weight)) return { ...base, reason: 'degenerate' }
  // Вес — доля, а не множитель: за пределами [0, 1] это не «уточнённое
  // значение», а сообщение о том, что модель не описывает данные. Подрезать его
  // к краю значило бы спрятать это сообщение.
  if (cap <= 0 || weight < 0 || weight > 1) {
    return { ...base, reason: 'out-of-range', rejected: { cap, weight } }
  }

  const residualPp = median(
    points.map((point) => Math.abs(predict(point, cap, weight) - point.pct)),
  )
  const caps = [...impliedCaps(points, weight).values()]
  const spread = caps.length < 2 ? 0 : (Math.max(...caps) - Math.min(...caps)) / median(caps)

  return { ...base, cap, weight, residualPp, capSpread: spread }
}

/**
 * Окна, чей потолок не сходится с остальными.
 *
 * Пункт 1 подводных камней: чужой расход, не оставивший следа в наших логах,
 * занижает потолок окна — процент вырос больше, чем оправдывает наша сумма.
 * Обратный перекос тоже наблюдение о чём-то другом, поэтому правило
 * двустороннее. Усреднять такое окно с остальными нельзя: ровно этим больна
 * ветка «cross-device» у Claude-Code-Usage-Monitor.
 *
 * Каждое окно решается **само** — своей парой (потолок, вес) по своим точкам, —
 * и сравниваются медианы. Взять вместо этого общее решение и посмотреть на
 * остатки нельзя: одно окно с чужим расходом уводит общее решение за пределы
 * доли, и отсев после него не запускается вовсе (проверено: вес выходил −0.17).
 * Окно, которое своими точками не решается, не судится — «не знаю» это не
 * «выброшено».
 */
function capOutliers(points: readonly UsagePoint[], kind: UsageWindowKind): DroppedWindow[] {
  const byWindow = new Map<number, UsagePoint[]>()
  for (const point of points) {
    byWindow.set(point.resetsAt, [...(byWindow.get(point.resetsAt) ?? []), point])
  }
  const caps = new Map<number, number>()
  for (const [resetsAt, group] of byWindow) {
    const cap = solve(group, kind).cap
    if (cap !== null) caps.set(resetsAt, cap)
  }
  // Медиане нужно на что опереться: при двух окнах «медианный потолок» это одно
  // из них, и правило выбросило бы второе просто за то, что оно другое.
  if (caps.size < CALIBRATION.minWindows) return []
  const middle = median([...caps.values()])
  if (!(middle > 0)) return []

  const out: DroppedWindow[] = []
  for (const [resetsAt, cap] of caps) {
    if (Math.abs(cap - middle) / middle <= CALIBRATION.maxCapDeviation) continue
    out.push({
      kind,
      resetsAt,
      reason: 'cap-outlier',
      points: byWindow.get(resetsAt)!.length,
    })
  }
  return out
}

/** Потолок, подразумеваемый каждым окном по отдельности при известном весе. */
function impliedCaps(points: readonly UsagePoint[], weight: number): Map<number, number> {
  const byWindow = new Map<number, number[]>()
  for (const point of points) {
    const cap = ((point.plain + weight * point.cacheRead) * 100) / point.pct
    byWindow.set(point.resetsAt, [...(byWindow.get(point.resetsAt) ?? []), cap])
  }
  return new Map([...byWindow].map(([resetsAt, caps]) => [resetsAt, median(caps)]))
}

function predict(point: UsagePoint, cap: number, weight: number): number {
  return ((point.plain + weight * point.cacheRead) * 100) / cap
}

function emptyFit(kind: UsageWindowKind): Fit {
  return {
    kind,
    points: 0,
    windows: 0,
    cap: null,
    weight: null,
    residualPp: null,
    capSpread: null,
    shareSpread: 0,
    reason: 'no-points',
  }
}

interface PrefixTotals {
  /** Сумма по запросам в `[from, to]` включительно. */
  between(from: number, to: number): { plain: number; cacheRead: number }
}

/**
 * Префиксные суммы по отсортированным запросам.
 *
 * Точек в журнале тысячи, запросов — сотни тысяч; наивный обход на каждую точку
 * превращает калибровку в минуты работы на каждом снимке настроек.
 */
function prefixTotals(requests: readonly LimitRequest[]): PrefixTotals {
  const sorted = [...requests].sort((left, right) => left.ts - right.ts)
  const times = sorted.map((request) => request.ts)
  const plain = new Float64Array(sorted.length + 1)
  const cacheRead = new Float64Array(sorted.length + 1)
  for (const [index, request] of sorted.entries()) {
    plain[index + 1] = plain[index]! + request.input + request.cacheWrite + request.output
    cacheRead[index + 1] = cacheRead[index]! + request.cacheRead
  }
  return {
    between(from, to) {
      const start = lowerBound(times, from)
      const end = upperBound(times, to)
      if (end <= start) return { plain: 0, cacheRead: 0 }
      return {
        plain: plain[end]! - plain[start]!,
        cacheRead: cacheRead[end]! - cacheRead[start]!,
      }
    },
  }
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (values[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (values[middle]! <= target) low = middle + 1
    else high = middle
  }
  return low
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
