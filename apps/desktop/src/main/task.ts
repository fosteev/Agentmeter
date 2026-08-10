/**
 * Раскрытая строка ленты → `TaskCard` контракта 0.4. Раздел 4 макета
 * (строки 834–909).
 *
 * Тот же довод, что у `day.ts` и `snapshot.ts`: считается здесь и только здесь.
 * Окну остаются длины полосок внутри своих диаграмм — высота столбика против
 * самого высокого столбика и ширина полосы инструмента против самой дорогой.
 *
 * ## Что здесь суждение, а не данные
 *
 * Три поля карточки — не цифры, а утверждения: `TimelinePoint.note`
 * («чем выделен этот запрос»), `timelineNote` («сколько таких и во что они
 * встали»), `BreakdownRow.note` («чем выделена эта строка») и `note`
 * («что говорит раскладка токенов»). Модель для них написана ниже и держится
 * на трёх правилах.
 *
 * **Первое: помечаем только то, что можем назвать.** Контракт говорит прямо —
 * пометка выделения это причина, а не флаг. Красный столбик, про который нельзя
 * спросить «чем он красный», хуже отсутствия пометки: он пугает и не сообщает.
 *
 * **Второе: платит следующий запрос.** Результат инструмента приезжает в промпт
 * **следующего** запроса, и арифметика 1.6 это показывает без остатка:
 * `total(N+1) − total(N) = маржинальная стоимость вызовов N + output(N+1)`.
 * Значит высокий столбик объясняется вызовами предыдущего запроса, а не своими.
 * Пометь мы запрос, сделавший вызов, — красным оказался бы столбик обычной
 * высоты, а взлетевший рядом остался бы без объяснения.
 *
 * **Третье: причина называется по байтам, а не по токенам.** У 16 361 вызова из
 * 36 544 стоимость получена дележом дельты между параллельными вызовами
 * (`basis: 'split'`), и «чей вклад в промпт больше» там — результат деления, а
 * не измерение. Байты результата измерены всегда. Поэтому имя инструмента в
 * причине берётся у самого объёмного результата, а число рядом с ним — общий
 * рост промпта, который измерен целиком.
 *
 * Пороги подобраны на живом индексе (578 сессий, 28 255 запросов): выделенных
 * точек получается 160 на 28 167, задач с хотя бы одной пометкой — 104 из 539,
 * больше шести пометок нет ни у одной задачи. Ослабь порог вдвое — и
 * выделение перестанет что-либо значить, потому что выделено будет всё.
 */
import {
  breakdownReport,
  changedFiles,
  dayRange,
  formatTokens,
  t,
  taskDetail,
  taskRows,
  todayReport,
  type Config,
  type Db,
  type TaskCall,
  type TaskRequest,
  type ToolBreakdownRow,
  type Totals,
} from '@agentmeter/core'
import type { BreakdownRow, Measured, TaskCard, TimelinePoint, TokenSlice } from '@agentmeter/ipc'
import { toTaskRow } from './day.ts'
import { measured } from './measured.ts'

/**
 * Ниже какого роста промпта запрос не выделяется никогда.
 *
 * Абсолютный пол нужен рядом с относительным порогом: в задаче из трёх дешёвых
 * запросов пятикратный рост над медианой даёт 900 токенов вместо 180, и
 * сообщать об этом красным цветом значит кричать о пустом месте.
 */
const GROWTH_FLOOR = 20_000
/** Во сколько раз рост должен превысить обычный для этой задачи. */
const GROWTH_TIMES = 5
/** Какую долю байтов должен держать вызов, чтобы называться причиной поимённо. */
const DOMINANT_BYTES = 0.5
/** Во сколько раз вызов инструмента должен быть дороже среднего по задаче. */
const COSTLY_TIMES = 5
/** И какую долю расхода инструментов держать, чтобы это была не мелочь. */
const COSTLY_SHARE = 0.1
/** Сколько путей показываем поимённо; сколько их всего, приезжает отдельно. */
const KEEP_PATHS = 4
/** С какой доли чтения кэша про него есть что сказать. */
const REREAD_SHARE = 0.5

export interface TaskArg {
  sessionId: string
  from: number
  to: number
}

export function buildTaskCard(db: Db, arg: TaskArg, config: Config): TaskCard | null {
  const range = { from: arg.from, to: arg.to }
  // Строка берётся из той же сборки, что и лента, а не отдельным запросом с
  // похожими условиями: так шапка карточки и свёрнутая строка над ней не могут
  // разойтись в принципе — это буквально один и тот же объект.
  const row = taskRows(db, range).find((task) => task.sessionId === arg.sessionId)
  if (row === undefined) return null

  const locale = config.ui.locale
  const detail = taskDetail(db, arg.sessionId, range)
  const total = row.totals.total
  const card: TaskCard = {
    task: toTaskRow(row),
    dayShare: dayShare(db, row.totals.total, range, config.ui.dayStartsAtHour),
    timeline: timeline(detail.requests, detail.calls, locale),
    tokens: slices(row.totals, row.approximate),
    tools: tools(
      breakdownReport(db, { sessionId: arg.sessionId, range }).tool,
      detail.calls,
      locale,
    ),
  }

  const caption = timelineNote(card.timeline, locale)
  if (caption !== undefined) card.timelineNote = caption
  const observation = note(detail.requests, row.totals.cacheRead, total, locale)
  if (observation !== undefined) card.note = { text: observation }
  const files = changedFiles(db, arg.sessionId, range)
  if (files.length > 0) {
    card.files = { total: files.length, paths: files.slice(0, KEEP_PATHS).map((file) => file.path) }
  }
  return card
}

/**
 * Доля задачи в сутках.
 *
 * Знаменатель — целые сутки, накрывающие период карточки: у вкладки «Сегодня»
 * период и есть день, и тогда это ровно «25% дневного расхода» из макета. Взять
 * сутки по началу задачи было бы соблазнительно и неверно — задача, начатая
 * вчера в 23:50, сравнивалась бы со вчерашним днём, а числитель у неё
 * сегодняшний.
 */
function dayShare(
  db: Db,
  tokens: number,
  range: { from: number; to: number },
  hour: number,
): number {
  const first = dayRange(range.from, hour)
  const last = dayRange(range.to - 1, hour)
  const day = todayReport(db, { from: first.from, to: Math.max(first.to, last.to) })
  const total = day.totals?.total ?? 0
  return total === 0 ? 0 : tokens / total
}

/**
 * Столбик на запрос плюс причина у выделенных.
 *
 * Прореживания нет намеренно: у 99% задач запросов меньше трёхсот, а свёртка
 * соседних точек в одну — это усреднение, после которого одиночный дорогой
 * запрос перестаёт быть видимым, то есть исчезает ровно то, ради чего на
 * таймлайн смотрят.
 */
function timeline(
  requests: readonly TaskRequest[],
  calls: readonly TaskCall[],
  locale: string,
): TimelinePoint[] {
  const byRequest = new Map<string, TaskCall[]>()
  for (const call of calls) {
    const key = `${call.sessionId} ${call.seq}`
    const list = byRequest.get(key)
    if (list === undefined) byRequest.set(key, [call])
    else list.push(call)
  }
  // Рост промпта, за который платит запрос: это вызовы предыдущего.
  const growth = requests.map((_, index) => {
    if (index === 0) return { tokens: 0, calls: [] as TaskCall[] }
    const before = requests[index - 1]!
    const list = byRequest.get(`${before.sessionId} ${before.seq}`) ?? []
    return { tokens: list.reduce((sum, call) => sum + call.marginalTokens, 0), calls: list }
  })
  const usual = median(growth.map(({ tokens }) => tokens).filter((tokens) => tokens > 0))

  return requests.map((request, index) => {
    const point: TimelinePoint = { ts: request.ts, tokens: request.total }
    const reason = why(request, growth[index]!, usual, locale)
    if (reason !== undefined) point.note = reason
    return point
  })
}

/**
 * Чем выделен запрос — или ничем.
 *
 * Сжатие контекста стоит первым и порога не имеет: это не оценка величины, а
 * событие из лога. Момент, в котором контекст пересобрали, объясняет и провал
 * столбика, и то, что дальше кэш пишется заново — тот самый расход, который
 * разбирается в 4.4.
 */
function why(
  request: TaskRequest,
  growth: { tokens: number; calls: TaskCall[] },
  usual: number,
  locale: string,
): string | undefined {
  if (request.compacted) return t('note.compaction')
  if (growth.tokens < GROWTH_FLOOR) return undefined
  if (usual > 0 && growth.tokens < GROWTH_TIMES * usual) return undefined

  const size = formatTokens(growth.tokens, locale)
  const bytes = growth.calls.reduce((sum, call) => sum + call.resultBytes, 0)
  const top = [...growth.calls].sort(
    (left, right) => right.resultBytes - left.resultBytes || left.idx - right.idx,
  )[0]
  if (top === undefined) return undefined

  const images = growth.calls.filter((call) => call.hasImage).length
  if (images > 0) return t('note.images', { count: images, tokens: size })
  // Один результат крупнее всех остальных вместе — его и называем. Иначе
  // называть некого: у пятнадцати параллельных `exec_command` виноват не
  // какой-то один, а то, что их пятнадцать.
  if (bytes > 0 && top.resultBytes >= DOMINANT_BYTES * bytes) {
    const path = top.paths.length === 1 ? top.paths[0] : undefined
    return path === undefined
      ? t('note.bigResult', { tool: top.name, tokens: size })
      : t('note.bigResultFile', { tool: top.name, path, tokens: size })
  }
  return t('note.spread', { count: growth.calls.length, tokens: size })
}

/**
 * Подпись под таймлайном.
 *
 * Считает выделенные точки и их общую стоимость. Слова зависят от того, чем
 * они выделены: «дороже прочих» про сжатие контекста было бы неправдой — оно
 * как раз удешевляет следующий запрос.
 */
export function timelineNote(points: readonly TimelinePoint[], locale: string): string | undefined {
  const marked = points.filter((point) => point.note !== undefined)
  if (marked.length === 0) return undefined
  const tokens = formatTokens(
    marked.reduce((sum, point) => sum + point.tokens, 0),
    locale,
  )
  // «Сжатие» узнаётся сравнением с его же переводом, а не с русской строкой:
  // иначе на английском все пометки оказались бы «дороже прочих», включая те,
  // что как раз удешевляют следующий запрос.
  const compacted = marked.filter((point) => point.note === t('note.compaction')).length
  if (compacted === marked.length) return t('note.compactions', { count: compacted, tokens })
  if (compacted === 0) return t('note.costlier', { count: marked.length, tokens })
  return t('note.marked', { count: marked.length, tokens })
}

/** Четыре вида токенов в порядке макета, с долями от суммы задачи. */
function slices(totals: Totals, approximate: boolean): TokenSlice[] {
  const share = (value: number): number => (totals.total === 0 ? 0 : value / totals.total)
  const exact = (value: number): Measured => ({ value, confidence: 'exact' })
  return [
    { kind: 'input', tokens: exact(totals.input), share: share(totals.input) },
    { kind: 'cacheWrite', tokens: exact(totals.cacheWrite), share: share(totals.cacheWrite) },
    {
      kind: 'cacheRead',
      tokens: measured(totals.cacheRead, approximate),
      share: share(totals.cacheRead),
    },
    { kind: 'output', tokens: exact(totals.output), share: share(totals.output) },
  ]
}

/**
 * Инструменты задачи по расходу вниз.
 *
 * Список не подрезается: инструментов на задачу медианно три, p99 — девять, и
 * ради одного процента задач прятать строки значит показывать неполную
 * раскладку в остальных 99% без единого признака того, что она неполная.
 */
function tools(
  rows: readonly ToolBreakdownRow[],
  calls: readonly TaskCall[],
  locale: string,
): BreakdownRow[] {
  const images = new Map<string, number>()
  for (const call of calls) {
    if (call.hasImage) images.set(call.name, (images.get(call.name) ?? 0) + 1)
  }
  const value = (row: ToolBreakdownRow): number =>
    row.tokens.measured + row.tokens.split + row.tokens.unknown
  const count = (row: ToolBreakdownRow): number =>
    row.calls.measured + row.calls.split + row.calls.unknown
  const spend = rows.reduce((sum, row) => sum + value(row), 0)
  const everyCall = rows.reduce((sum, row) => sum + count(row), 0)
  const average = everyCall === 0 ? 0 : spend / everyCall

  return rows.map((row): BreakdownRow => {
    const made = count(row)
    const tokens = value(row)
    const result: BreakdownRow = {
      key: row.key,
      label: row.key,
      axis: 'tool',
      marginal: cost(tokens, row),
      // Постоянная стоимость инструмента — это его схема в стартовом префиксе,
      // и сводится она в 4.1. Ноль здесь не заглушка: схема тула в префиксе
      // задачи ничего не стоит сверх того, что уже посчитано в префиксе сессии.
      recurring: { value: 0, confidence: 'exact' },
      calls: made,
    }
    const reason = costly(row.key, tokens, made, average, spend, images.get(row.key) ?? 0, locale)
    if (reason !== undefined) result.note = reason
    return result
  })
}

/**
 * Чем выделена строка инструмента.
 *
 * Дорого — это не «много токенов всего», а «много токенов на вызов»: сто
 * дешёвых `Bash` набирают больше любого другого инструмента просто числом, и
 * красить их за это значит ругать человека за то, что он работал. Выделяется
 * инструмент, у которого вызов стоит кратно дороже среднего по задаче и
 * который при этом заметен в её расходе.
 */
function costly(
  name: string,
  tokens: number,
  calls: number,
  average: number,
  spend: number,
  images: number,
  locale: string,
): string | undefined {
  if (calls === 0 || average === 0) return undefined
  const per = tokens / calls
  if (per < COSTLY_TIMES * average || tokens < COSTLY_SHARE * spend) return undefined
  if (images > 0) {
    return t('note.toolImages', { count: images, per: formatTokens(Math.round(per), locale) })
  }
  return t('note.toolCostly', {
    per: formatTokens(Math.round(per), locale),
    average: formatTokens(Math.round(average), locale),
    tool: name,
  })
}

/**
 * Наблюдение под раскладкой токенов.
 *
 * Говорит ровно про то, что видно в раскладке: чтение кэша занимает у задач
 * медианно 93% расхода, и человеку, впервые увидевшему свои цифры, надо
 * объяснить, откуда берётся такая доля. Совета здесь нет — вторая половина
 * фразы (`advice`) появится вместе с рекомендациями в 4.3; сочинить её сейчас
 * значило бы посоветовать «разбейте на две сессии» там, где это дороже.
 */
export function note(
  requests: readonly TaskRequest[],
  cacheRead: number,
  total: number,
  locale: string,
): string | undefined {
  if (total === 0 || cacheRead / total < REREAD_SHARE) return undefined
  const rereads = requests.filter((request) => request.cacheRead > 0).length
  if (rereads < 2) return undefined
  const peak = Math.max(0, ...requests.map((request) => request.contextTokens))
  const grew = peak === 0 ? '' : t('note.rereadGrew', { peak: formatTokens(peak, locale) })
  return t('note.reread', { count: rereads, grew })
}

/**
 * Точность строки инструмента.
 *
 * Через дележ между параллельными вызовами проходит 33% расхода у Claude и 72%
 * у Codex (1.6), и такая строка обязана приезжать оценкой. Отдельно помечается
 * недомер: у вызовов последнего запроса следующего нет, и их стоимость не
 * измерена вовсе — строка тогда не оценка, а нижняя граница, и молчать об этом
 * нельзя.
 */
function cost(tokens: number, row: ToolBreakdownRow): Measured {
  if (row.calls.split > 0) {
    return { value: tokens, confidence: 'estimate', caveat: t('caveat.split') }
  }
  if (row.calls.unknown > 0) {
    return { value: tokens, confidence: 'estimate', caveat: t('caveat.unmeasured') }
  }
  return { value: tokens, confidence: 'exact' }
}

/** Медиана без сортировки на месте: вход общий с другими расчётами. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}
