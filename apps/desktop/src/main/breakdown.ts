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
import {
  breakdownReport,
  cacheRebuilds,
  hasRequests,
  loadedCategories,
  savings,
  spendSplit,
  sourceCount,
  t,
  type CacheRebuildReport,
  type Db,
  type LoadedCategory,
  type LoadedSource,
  type Saving,
  type RequestScope,
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
  const tools = breakdownReport(db, { range })
  // Точность наследуется от итога ровно так же, как в «Сегодня»: внутри обеих
  // долей лежат восстановленные запросы (1.3), и доля от неточного целого
  // точной быть не может.
  const approximate = reconstructed(db, range, scope)
  const perSession = filter.scope === 'session'
  const sessions = Math.max(1, split.sessions)

  return {
    range,
    scope: filter.scope,
    emptyIndex: sourceCount(db) === 0,
    emptyScope: !hasRequests(db, range),
    sessions: split.sessions,
    // Переключатель делит **всё** одним и тем же знаменателем, включая полосу
    // над колонками: покажи она расход дня над таблицей за сессию — на экране
    // оказались бы два масштаба сразу, и оба выглядели бы настоящими. Доли при
    // этом не меняются, меняются только абсолютные числа.
    ...scaled(toSpendSplit(split, approximate), perSession ? sessions : 1),
    recurring: categories.map((row) => toCategoryRow(row, approximate, perSession, sessions)),
    ...toAdvice(savings(db, range, scope), approximate, perSession, sessions),
    tools: tools.tool.map(toToolRow),
    toolCalls: tools.tool.reduce((sum, row) => sum + basisSum(row.calls), 0),
    beforeFirstWord: beforeFirstWord(categories, approximate, sessions, perSession),
    reread: {
      // Сколько раз префикс перечитан сверх первой записи. Не число запросов:
      // сессия, начавшаяся вчера, платит сегодня за каждый свой запрос, а
      // записала префикс вчера — и первой записи в этом периоде у неё нет.
      times: rereadTimes(split.recurring, split.firstRead, sessions),
      tokens: measured(
        Math.round((split.recurring - split.firstRead) / (perSession ? sessions : 1)),
        approximate,
      ),
    },
    ...toRebuilds(
      cacheRebuilds(db, { range, scope }),
      split.total,
      approximate,
      perSession ? sessions : 1,
    ),
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
  }
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
 */
function toToolRow(row: {
  key: string
  calls: Record<'measured' | 'split' | 'unknown', number>
  tokens: Record<'measured' | 'split' | 'unknown', number>
}): BreakdownRow {
  const calls = basisSum(row.calls)
  const tokens = basisSum(row.tokens)
  const exact = row.calls.split === 0 && row.calls.unknown === 0
  const marginal: Measured = exact
    ? { value: tokens, confidence: 'exact' }
    : { value: tokens, confidence: 'estimate', caveat: t(caveatKey(row.calls)) }
  return {
    key: row.key,
    label: row.key,
    axis: 'tool',
    marginal,
    recurring: { value: 0, confidence: 'exact' },
    calls,
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

function reconstructed(db: Db, range: { from: number; to: number }, scope: RequestScope): boolean {
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
  return (
    db.get<{ one: number }>(
      `SELECT 1 AS one FROM requests
       JOIN sessions ON sessions.id = requests.session_id
       WHERE ${filter.join(' AND ')} AND requests.origin != 'log' LIMIT 1`,
      ...params,
    ) !== undefined
  )
}
