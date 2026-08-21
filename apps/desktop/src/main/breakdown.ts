/**
 * Вкладка «Развёртка» (4.2) — раздел 5 макета.
 *
 * Тот же довод, что у `day.ts`: считается здесь и только здесь. Окно получает
 * готовые числа, доли, которые видно текстом, и названия статей; ему остаётся
 * подогнать длину полос под ширину своей диаграммы.
 *
 * Отдельным файлом от `day.ts`, потому что общего у экранов ровно одно —
 * полоса `split`, и она собирается одной функцией на оба: разойдись эти две
 * сборки, и на вкладке «Сегодня» было бы 41%, а на «Развёртке» 43% про тот же
 * день.
 */
import { homedir } from 'node:os'
import {
  cacheRebuilds,
  hasRequests,
  loadedCategories,
  savings,
  spendSplit,
  sourceCount,
  t,
  toolBreakdownRows,
  toolRowLabel,
  type CacheRebuildReport,
  type Db,
  type LoadedCategory,
  type LoadedSource,
  type Saving,
  type RequestScope,
  type ToolBreakdownRow,
} from '@agentmeter/core'
import { formatTokens } from '@agentmeter/core/format'
import { locale } from '@agentmeter/core/i18n'
import { measured } from './measured.ts'
import { toSpendSplit } from './day.ts'
import type {
  BreakdownRow,
  CacheRebuilds,
  Measured,
  SpendAdvice,
  SpendCategoryRow,
  SpendDetail,
  SpendScreen,
  SpendSourceRow,
  SpendSplit,
} from '@agentmeter/ipc'

/**
 * Как называется статья на экране.
 *
 * Ключ — категория плюс признак остатка, потому что `system` встречается в
 * обоих видах и означает разное: у Claude это неизмеримый остаток (системный
 * промпт со схемами вшитых тулов), у Codex — записанный в лог дословно
 * `base_instructions`. Одно имя на оба сказало бы, что мы измерили то, чего не
 * измеряли.
 */
const LABELS = {
  'system residual': 'breakdown.systemResidual',
  'system estimated': 'breakdown.systemPrompt',
  'toolSchemas residual': 'breakdown.toolSchemas',
  'toolSchemas estimated': 'breakdown.toolSchemas',
  'mcpTools estimated': 'breakdown.mcpTools',
  'mcpInstructions estimated': 'breakdown.mcpInstructions',
  'skills estimated': 'breakdown.skills',
  'agents estimated': 'breakdown.agents',
  'memory estimated': 'breakdown.memory',
  'deferredTools estimated': 'breakdown.deferredTools',
  'userTurn estimated': 'breakdown.userTurn',
} as const

export interface BreakdownFilter {
  scope: 'day' | 'session'
  from: number
  to: number
  provider?: 'claude' | 'codex'
  project?: string
}

export function buildSpendScreen(db: Db, filter: BreakdownFilter): SpendScreen {
  const range = { from: filter.from, to: filter.to }
  const scope: RequestScope = {}
  if (filter.provider !== undefined) scope.provider = filter.provider
  if (filter.project !== undefined) scope.project = filter.project

  const split = spendSplit(db, range, scope)
  const categories = loadedCategories(db, range, scope)
  // Сужение доезжает и до правой колонки: экран собирается из двух источников,
  // и фильтр, применённый к одному, дал бы две правды на одном экране.
  const tools = toolBreakdownRows(db, { range, scope })
  // Точность наследуется от итога ровно так же, как в «Сегодня»: внутри обеих
  // долей лежат восстановленные запросы (1.3), и доля от неточного целого
  // точной быть не может.
  const requests = scopedRequests(db, range, scope)
  const approximate = requests.reconstructed
  const perSession = filter.scope === 'session'
  const sessions = Math.max(1, split.sessions)
  const divisor = perSession ? sessions : 1
  const toolTokens = tools.reduce((sum, row) => sum + basisSum(row.tokens), 0)

  return {
    range,
    scope: filter.scope,
    emptyIndex: sourceCount(db) === 0,
    emptyScope: !hasRequests(db, range),
    sessions: split.sessions,
    // Переключатель делит **всё** одним и тем же знаменателем, включая полосу
    // над колонками и правую колонку: покажи она расход дня под полосой за
    // сессию — на экране оказались бы два масштаба сразу, и оба выглядели бы
    // настоящими. Не делятся только отношения — доли, множитель, средняя цена
    // вызова: у них знаменатель сокращается сам.
    ...scaled(toSpendSplit(split, approximate), divisor),
    recurring: categories.map((row) => toCategoryRow(row, approximate, perSession, sessions)),
    ...toAdvice(savings(db, range, scope), approximate, perSession, sessions),
    tools: tools.map((row) => toToolRow(row, divisor)),
    toolCalls: Math.round(tools.reduce((sum, row) => sum + basisSum(row.calls), 0) / divisor),
    toolTotal: toolTotal(tools, divisor),
    ...marginalRest(split, toolTokens, requests.count, approximate, divisor),
    beforeFirstWord: beforeFirstWord(categories, approximate, sessions, perSession),
    reread: {
      // Счёт раз — мера периода, делится переключателем; за сессию он совпадает
      // с множителем по построению: (R−F)/(F/N)/N = (R−F)/F. Не число запросов:
      // сессия, начавшаяся вчера, платит сегодня за каждый свой запрос, а
      // записала префикс вчера — и первой записи в этом периоде у неё нет.
      times: perSession
        ? rereadFactor(split.recurring, split.firstRead)
        : rereadTimes(split.recurring, split.firstRead, sessions),
      factor: rereadFactor(split.recurring, split.firstRead),
      tokens: measured(Math.round((split.recurring - split.firstRead) / divisor), approximate),
    },
    ...toRebuilds(cacheRebuilds(db, { range, scope }), split.total, approximate, divisor),
  }
}

/**
 * Итог правой колонки — готовым `Measured` (правило 3.0: число видно текстом).
 *
 * Знак — по строкам: сумма, где есть хоть одна оценка, точной не бывает, и
 * оговорка у неё та же, что у строк, — по большинству неточных вызовов.
 */
function toolTotal(rows: readonly ToolBreakdownRow[], divisor: number): Measured {
  const tokens = rows.reduce((sum, row) => sum + basisSum(row.tokens), 0)
  const calls = rows.reduce(
    (sum, row) => ({
      measured: sum.measured + row.calls.measured,
      split: sum.split + row.calls.split,
      unknown: sum.unknown + row.calls.unknown,
    }),
    { measured: 0, split: 0, unknown: 0 },
  )
  const value = Math.round(tokens / divisor)
  return calls.split === 0 && calls.unknown === 0
    ? { value, confidence: 'exact' }
    : { value, confidence: 'estimate', caveat: t(caveatKey(calls)) }
}

/**
 * Остаток разового сверх строк инструментов — строки сходимости из макета
 * (1141–1150): ответы модели, ввод человека и перечитывание результатов на
 * каждом следующем запросе. Без него «Разовый · по вызовам» над колонкой,
 * итог которой в разы меньше подписи оси, — обещание без исполнения.
 *
 * Считается вычитанием из того же среза, что в полосе, а не своей суммой:
 * второй счёт разового разошёлся бы с первым (правило 4.1). Поля нет вместе
 * со `split` — остаток от нуля не считается.
 */
function marginalRest(
  split: { total: number; marginal: number },
  toolTokens: number,
  requests: number,
  approximate: boolean,
  divisor: number,
): { marginalRest?: { requests: number; tokens: Measured } } {
  if (split.total === 0) return {}
  return {
    marginalRest: {
      requests: Math.round(requests / divisor),
      tokens: measured(Math.round((split.marginal - toolTokens) / divisor), approximate),
    },
  }
}

/**
 * Пересборки кэша (4.4) — блок «Переплата за паузу».
 *
 * Поля нет вовсе, когда мерить нечем (`measurable === false`, то есть в периоде
 * один Codex) **или** когда пересборок не было ни одной: пустая таблица из
 * четырёх нулей читается как «мы посчитали, и не было», а первое из этих двух —
 * неправда.
 *
 * Доля считается здесь, потому что она видна числом и рядом с ней стоит текст
 * (правило 3.0). Знаменатель — тот же итог периода, что в шапке (4.1): второго
 * знаменателя у разложения нет и быть не может. И делится доля **до** масштаба
 * «за сессию»: доля от неё не зависит, а абсолютные числа зависят.
 */
function toRebuilds(
  report: CacheRebuildReport,
  total: number,
  approximate: boolean,
  divisor: number,
): { rebuilds?: CacheRebuilds } {
  if (!report.measurable || report.total.count === 0) return {}
  const group = (value: { count: number; tokens: number }): CacheRebuilds['start'] => ({
    count: value.count,
    tokens: measured(Math.round(value.tokens / divisor), approximate),
  })
  const rebuilds: CacheRebuilds = {
    start: group(report.start),
    pause: group(report.pause),
    early: group(report.early),
    compact: group(report.compact),
    total: group(report.total),
    share: total === 0 ? 0 : report.total.tokens / total,
    buckets: report.buckets.map((bucket) => ({
      fromMs: bucket.fromMs,
      toMs: bucket.toMs,
      count: bucket.count,
      tokens: measured(Math.round(bucket.tokens / divisor), approximate),
    })),
    ttlMs: report.ttlMs,
  }
  const worst = report.worst
  if (worst && worst.pauseMs !== null) {
    rebuilds.worst = {
      pauseMs: worst.pauseMs,
      tokens: measured(worst.tokens, approximate),
      from: worst.ts - worst.pauseMs,
      to: worst.ts,
      project: worst.project,
      branch: worst.branch,
    }
  }
  return { rebuilds }
}

/**
 * Советы по экономии (4.3) — что грузилось в каждую сессию и не понадобилось.
 *
 * Показываются три самых дорогих, остальные названы числом: молчаливая обрезка
 * читается как «это всё», а на живых логах таких серверов девятнадцать. Фраза
 * собирается здесь, потому что это суждение — «отключение вернёт столько-то», —
 * а не подстановка приехавшего числа в шаблон (правило 3.0).
 *
 * Поля нет вовсе, когда советовать нечего: пустой список на экране обещал бы,
 * что советы бывают, но не сегодня.
 */
const ADVICE_SHOWN = 3

function toAdvice(
  rows: readonly Saving[],
  approximate: boolean,
  perSession: boolean,
  sessions: number,
): { advice?: SpendAdvice[] } | Record<string, never> {
  if (rows.length === 0) return {}
  const shown = rows.slice(0, ADVICE_SHOWN).map((row, index): SpendAdvice => {
    const tokens = perSession ? Math.round(row.tokens / sessions) : row.tokens
    const advice: SpendAdvice = {
      source: row.source,
      tokens: measured(tokens, approximate),
      headline: t('breakdown.adviceHeadline', {
        source: row.source,
        tools: t('breakdown.adviceTools', { count: row.loaded }),
        calls: t('breakdown.adviceCalls', { count: 0 }),
      }),
      text:
        t('breakdown.adviceText', {
          count: row.sessions,
          tokens: formatTokens(tokens, locale()),
        }) +
        // Жадный режим называется прямо в тексте: там схемы неотделимы от
        // системного промпта, цена больше показанной, и насколько — неизвестно.
        // Промолчать значило бы выдать нижнюю оценку за всю экономию.
        (row.unmeasured > 0
          ? t('breakdown.adviceEager', { count: row.unmeasured })
          : ''),
    }
    if (index === ADVICE_SHOWN - 1 && rows.length > ADVICE_SHOWN) {
      advice.hidden = rows.length - ADVICE_SHOWN
    }
    return advice
  })
  return { advice: shown }
}

/** Тот же `split`, поделённый на число сессий, когда экран показывает сессию. */
function scaled(
  value: { split?: SpendSplit },
  divisor: number,
): { split?: SpendSplit } | Record<string, never> {
  if (value.split === undefined || divisor === 1) return value
  return {
    split: {
      ...value.split,
      slices: value.split.slices.map((slice) => ({
        ...slice,
        tokens: { ...slice.tokens, value: Math.round(slice.tokens.value / divisor) },
      })),
    },
  }
}

/**
 * «Итого до первого слова» — префикс без реплики человека.
 *
 * Своя первая реплика лежит в том же префиксе и перечитывается так же, но
 * оверхедом не является: её нельзя выключить. Сложи мы её сюда — обещание
 * экономии оказалось бы больше того, что можно сэкономить, ровно на длину
 * собственного вопроса.
 */
function beforeFirstWord(
  categories: readonly LoadedCategory[],
  approximate: boolean,
  sessions: number,
  perSession: boolean,
): SpendScreen['beforeFirstWord'] {
  const own = categories.filter((row) => row.category !== 'userTurn')
  const period = own.reduce((sum, row) => sum + row.tokens, 0)
  return {
    perSession: measured(Math.round(period / sessions), approximate),
    period: measured(perSession ? Math.round(period / sessions) : period, approximate),
  }
}

/**
 * Во сколько раз префикс перечитан сверх первой записи.
 *
 * Считается из токенов, а не из числа запросов: у сессий разный префикс, и
 * «×46» обязано означать «постоянное во столько раз больше однократной
 * записи», иначе множитель и числа рядом с ним разойдутся.
 *
 * Экспортируется затем же, зачем `spendNote` и `foldTail`: это правило, а не
 * оформление, и проверять его надо на известном ответе, а не на том, что
 * случайно выпало на фикстурах.
 */
export function rereadTimes(recurring: number, firstRead: number, sessions: number): number {
  const once = firstRead > 0 ? firstRead / sessions : 0
  return once === 0 ? 0 : Math.round((recurring - firstRead) / once)
}

/**
 * Во сколько раз постоянное сессии больше её однократной записи.
 *
 * Отношение, а не мера: переключатель «за день / за сессию» его не меняет —
 * числитель и знаменатель делятся на одно число сессий. Ровно поэтому оно и
 * стоит в колонке «За сессию» рядом со счётом раз за период (`rereadTimes`):
 * счёт периода в той колонке значил бы, что каждая сессия перечитала префикс
 * за все сессии сразу.
 */
export function rereadFactor(recurring: number, firstRead: number): number {
  return firstRead > 0 ? Math.round((recurring - firstRead) / firstRead) : 0
}

function toCategoryRow(
  row: LoadedCategory,
  approximate: boolean,
  perSession: boolean,
  sessions: number,
): SpendCategoryRow {
  const key = `${row.category} ${row.basis}`
  return {
    key,
    label: t(LABELS[key as keyof typeof LABELS] ?? 'breakdown.other'),
    perSession: measured(row.perSession, approximate),
    // Переключатель меняет знаменатель, а не фильтр: «за сессию» — это тот же
    // расход, делённый на число сессий периода.
    period: measured(perSession ? Math.round(row.tokens / sessions) : row.tokens, approximate),
    loaded: row.loaded,
    used: row.used,
    estimate: row.basis === 'estimated',
    sources: row.sources.map((source) => toSourceRow(source, approximate, perSession, sessions)),
    detail: toDetail(row, key),
  }
}

/**
 * Пояснения к статьям, которые перечислить нечем, — по ключу строки (4.9).
 *
 * Каждой причине своя фраза, и это не многословие. «Пусто» у остатка значит
 * «состоит не из штук», у первой реплики — «показывать запрещено настройкой», у
 * памяти Codex — «источник не назвал». Общее слово на три случая сказало бы, что
 * мы посмотрели и не нашли, — а мы в двух из трёх даже не смотрели.
 */
const DETAIL_NOTES = {
  'system residual': 'breakdown.detailResidual',
  'toolSchemas residual': 'breakdown.detailResidual',
  'system estimated': 'breakdown.detailSystem',
  'userTurn estimated': 'breakdown.detailUserTurn',
} as const

/**
 * Состав статьи для подсказки.
 *
 * Оговорка про сессии без имён идёт **вместе** со списком, а не вместо него:
 * день смешивает провайдеров, и статья «Файлы памяти» на дне из Claude и Codex
 * имеет и настоящие имена, и сессии, где их не назвали.
 */
function toDetail(row: LoadedCategory, key: string): SpendDetail {
  const detail: SpendDetail = {
    names: row.names.map((item) => ({ name: displayName(row.category, item.name), sessions: item.sessions })),
    sessions: row.sessions,
    unnamed: row.unnamed,
  }
  const fixed = DETAIL_NOTES[key as keyof typeof DETAIL_NOTES]
  if (fixed !== undefined) detail.note = t(fixed)
  else if (row.unnamed > 0) detail.note = t('breakdown.detailUnnamed', { count: row.unnamed })
  else if (detail.names.length === 0 && row.sources.length === 0)
    detail.note = t('breakdown.detailNone')
  return detail
}

/**
 * Как имя выглядит на экране.
 *
 * Сокращается только показ: в индексе у файла памяти лежит абсолютный путь, и
 * лежит он там затем, что `displayPath` из лога относителен рабочему каталогу —
 * один и тот же `CLAUDE.md` записан в разных сессиях тремя строками. Сложи мы
 * их по показанному виду, и один файл стал бы тремя, каждый «в 1 сессии из 14».
 */
function displayName(category: LoadedCategory['category'], name: string): string {
  if (category !== 'memory') return name
  const home = homedir()
  return home !== '' && name.startsWith(`${home}/`) ? `~${name.slice(home.length)}` : name
}

function toSourceRow(
  source: LoadedSource,
  approximate: boolean,
  perSession: boolean,
  sessions: number,
): SpendSourceRow {
  return {
    source: source.source,
    period: measured(perSession ? Math.round(source.tokens / sessions) : source.tokens, approximate),
    perSession: measured(source.perSession, approximate),
    loaded: source.loaded,
    used: source.used,
    calls: source.calls,
  }
}

/**
 * Строка правой колонки. Точность — из самой атрибуции (1.6): через дележ между
 * параллельными вызовами проходит треть расхода у Claude и почти три четверти у
 * Codex, и такая строка обязана приезжать оценкой со своей оговоркой.
 *
 * Токены и вызовы — в масштабе переключателя; средняя цена вызова — из сырых
 * чисел периода: отношение от знаменателя не зависит, а деление показанных
 * друг на друга ломается на счётчике, округлённом до нуля.
 */
function toToolRow(row: ToolBreakdownRow, divisor: number): BreakdownRow {
  const calls = basisSum(row.calls)
  const tokens = basisSum(row.tokens)
  const value = Math.round(tokens / divisor)
  const exact = row.calls.split === 0 && row.calls.unknown === 0
  const marginal: Measured = exact
    ? { value, confidence: 'exact' }
    : { value, confidence: 'estimate', caveat: t(caveatKey(row.calls)) }
  return {
    key: row.key,
    label: toolRowLabel(row.key),
    axis: 'tool',
    marginal,
    recurring: { value: 0, confidence: 'exact' },
    calls: Math.round(calls / divisor),
    average: calls === 0 ? 0 : Math.round(tokens / calls),
  }
}

function caveatKey(
  calls: Record<'measured' | 'split' | 'unknown', number>,
): 'caveat.split' | 'caveat.unmeasured' {
  return calls.split >= calls.unknown ? 'caveat.split' : 'caveat.unmeasured'
}

function basisSum(values: Record<'measured' | 'split' | 'unknown', number>): number {
  return values.measured + values.split + values.unknown
}

/**
 * Сколько запросов попало в сужение и есть ли среди них восстановленные (1.3).
 *
 * Одним запросом, потому что оба ответа — про один и тот же отфильтрованный
 * набор: счёт нужен строке остатка («N запросов»), признак — знаку `≈` всего
 * экрана.
 */
function scopedRequests(
  db: Db,
  range: { from: number; to: number },
  scope: RequestScope,
): { count: number; reconstructed: boolean } {
  const filter: string[] = ['requests.ts >= ?', 'requests.ts < ?']
  const params: Array<number | string> = [range.from, range.to]
  if (scope.provider !== undefined) {
    filter.push('sessions.provider = ?')
    params.push(scope.provider)
  }
  if (scope.project !== undefined) {
    filter.push('sessions.project = ?')
    params.push(scope.project)
  }
  const row = db.get<{ count: number; reconstructed: number }>(
    `SELECT count(*) AS count,
            coalesce(sum(requests.origin != 'log'), 0) AS reconstructed
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.join(' AND ')}`,
    ...params,
  )
  return { count: row?.count ?? 0, reconstructed: (row?.reconstructed ?? 0) > 0 }
}
