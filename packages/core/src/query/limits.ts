import type { ClaudeLimits } from '../config/types.ts'
import type { Db, SqlValue } from '../index/db.ts'
import { readLimitWindows } from '../index/limits.ts'

import { DEFAULT_RATE_WINDOW_MS, perMinute } from '../live/rate.ts'
import type { UsageSnapshot } from '../limits/usage.ts'
import type { LimitWindow } from '../sources/types.ts'
import { sourceCount } from './today.ts'
import type { LimitForecast, LimitReportRow, LimitsReport } from './types.ts'

const MINUTE_MS = 60_000

/**
 * Отчёт только читает. Пересборку окон делает тот, кто менял вход: `ingestAll`
 * после прохода и живой слой при смене конфига (`ensureLimitWindows`).
 *
 * Раньше пересборка стояла прямо здесь, и это был полный проход по всем
 * запросам Claude на каждый опрос трея плюс скрытая запись из читающего
 * модуля — известный долг 1.10.
 */
/**
 * Свежие окна от провайдеров — то, что приехало по требованию, а не из логов.
 *
 * Два поля, потому что источники разные и по форме, и по происхождению: у
 * Claude процента в логах нет вовсе и ответ приходит снимком двух окон (6.3), у
 * Codex окна в логах есть, но устаревают, и ответ приходит уже готовыми окнами
 * (6.4). Слить их в один тип значило бы придумать общий, которого у провайдеров
 * нет.
 */
export interface FreshWindows {
  claude?: UsageSnapshot
  codex?: readonly LimitWindow[]
}

export function limitsReport(
  db: Db,
  at: number,
  limits: ClaudeLimits,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  fresh: FreshWindows = {},
): LimitsReport {
  const windows = replaceProvider(
    replaceProvider(readLimitWindows(db), 'claude', claudeWindows(fresh.claude)),
    'codex',
    fresh.codex,
  )
  return {
    emptyIndex: sourceCount(db) === 0,
    at,
    windows: windows
      .filter((window) => window.startsAt <= at && at < window.resetsAt)
      .map((window): LimitReportRow => ({
        ...window,
        unavailableReason: unavailableReason(window, limits),
        forecast: forecastFor(db, window, at, rateWindowMs),
      })),
  }
}

/**
 * Ответ провайдера сильнее нашего расчёта — и по проценту, и по границам (6.3).
 *
 * Процент понятно почему: у Claude в логах его нет вовсе, наш выводится из
 * потолка и веса `cache_read`, а до калибровки 1.9 он попросту `null`.
 *
 * Границы — менее очевидно и потому замерено. Наше окно якорится на первом
 * запросе после истечения прошлого, и на живой машине 11 августа это дало
 * 16:40–21:40 UTC против 19:40–00:40 у провайдера: ровно три часа мимо, при
 * том что пятичасовой паузы в запросах не было вовсе (самая большая — 82
 * минуты). Причина не в разборе, а в том, что **лимит считается по аккаунту**:
 * окно могло начаться с запроса, которого у нас нет, — с другой машины, из
 * веба, из Claude Desktop. Провайдер видит весь аккаунт, мы одну машину, и
 * спорить с ним нашей догадкой значит показывать человеку время сброса, до
 * которого он доработает и упрётся.
 *
 * Поэтому окна Claude **заменяются целиком**, а не дополняются процентом:
 * половина от провайдера и половина от нас — это строка, у которой процент
 * относится к одному интервалу, а «сброс через» к другому.
 *
 * У Codex (6.4) довод тот же с точностью до источника расхождения. Процент в
 * логах есть и он точный, но написан он в момент запроса: 10 августа лог
 * сообщал 44% недельного окна, а 12-го тот же аккаунт по ответу провайдера
 * стоял на нуле. И там, и там наши окна — расчёт по одной машине, а лимит
 * считается по аккаунту.
 */
function replaceProvider(
  windows: readonly LimitWindow[],
  provider: LimitWindow['provider'],
  fromProvider: readonly LimitWindow[] | undefined,
): LimitWindow[] {
  if (fromProvider === undefined || fromProvider.length === 0) return [...windows]
  const kinds = new Set(fromProvider.map((window) => window.kind))
  const kept = windows.filter(
    (window) => window.provider !== provider || !kinds.has(window.kind),
  )
  return [...kept, ...fromProvider]
}

/**
 * Снимок Claude → окна. Отдельно от `replaceProvider`, потому что у Claude
 * ответ приходит не окнами: в нём процент и момент сброса, а длина окна известна
 * из его вида — `session` пятичасовое, `weekly_all` недельное.
 */
function claudeWindows(provider: UsageSnapshot | undefined): LimitWindow[] {
  if (provider === undefined) return []
  const windows: LimitWindow[] = []
  for (const [kind, minutes] of [
    ['fiveHour', 300],
    ['weekly', 10_080],
  ] as const) {
    const sample = provider[kind]
    if (!sample) continue
    windows.push({
      provider: 'claude',
      kind,
      windowMinutes: minutes,
      startsAt: sample.resetsAt - minutes * MINUTE_MS,
      resetsAt: sample.resetsAt,
      usedPercent: sample.pct,
      // Момент **наблюдения**, а не последнего запроса: процент снят тогда, и
      // возраст снимка человек видит рядом с кнопкой «спросить».
      observedAt: provider.ts,
      exact: true,
    })
  }
  return windows
}

/**
 * Когда упрёмся в потолок — этап 2.3.
 *
 * Потолка в токенах у нас нет ни у одного провайдера: Codex сообщает только
 * процент, у Claude потолок задаётся руками и до 1.9 бесполезен. Зато процент
 * можно привязать к нашему собственному замеру: если за окно мы насчитали
 * `W` токенов и провайдер говорит «израсходовано `p`%», то цена процента —
 * `W / p` токенов, и остаток до потолка выражается в тех же токенах. Единица
 * при делении сокращается, поэтому взвешивать `cache_read` здесь не нужно —
 * и прогноз работает у Codex уже сейчас, до калибровки 1.9.
 *
 * Допущение ровно одно и оно названо: доля видов токенов в хвостовом окне та
 * же, что за всё окно лимита. Поэтому это оценка, а не измерение.
 */
function forecastFor(
  db: Db,
  window: LimitWindow,
  at: number,
  rateWindowMs: number,
): LimitForecast | null {
  // Ноль процентов не даёт цены процента: делить на него нечем, и это не то же
  // самое, что «темп нулевой».
  if (window.usedPercent === null || window.usedPercent <= 0) return null

  const windowSpent = spent(db, window.provider, window.startsAt, Math.min(at, window.resetsAt))
  if (windowSpent <= 0) return null

  // Хвостовое окно не должно вылезать за начало окна лимита: чужие токены в
  // числителе завысили бы темп ровно в момент, когда окно только открылось.
  const from = Math.max(at - rateWindowMs, window.startsAt)
  const tokensPerMinute = perMinute(spent(db, window.provider, from, at), at - from)
  if (tokensPerMinute === 0) return { tokensPerMinute: 0, minutesToCap: null, resetsFirst: false }

  const tokensToCap = (windowSpent / window.usedPercent) * (100 - window.usedPercent)
  const minutesToCap = Math.max(0, Math.round(tokensToCap / tokensPerMinute))
  return {
    tokensPerMinute,
    minutesToCap,
    resetsFirst: minutesToCap * 60_000 > window.resetsAt - at,
  }
}

function spent(db: Db, provider: string, from: number, to: number): number {
  if (to <= from) return 0
  const row = db.get<{ tokens: number | null }>(
    `SELECT sum(requests.input + requests.output + requests.cache_write + requests.cache_read) AS tokens
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE sessions.provider = ? AND requests.ts >= ? AND requests.ts < ?`,
    provider as SqlValue,
    from as SqlValue,
    to as SqlValue,
  )
  return row?.tokens ?? 0
}

function unavailableReason(window: LimitWindow, limits: ClaudeLimits): string | null {
  if (window.usedPercent !== null) return null
  if (window.provider !== 'claude') return 'провайдер не сообщил процент'
  if (limits.cacheReadWeight === null) return 'вес cache_read не откалиброван, этап 1.9'
  if (window.kind === 'fiveHour' && limits.fiveHourCap === null)
    return 'потолок пятичасового плана не задан'
  if (window.kind === 'weekly' && limits.weeklyCap === null)
    return 'потолок недельного плана не задан'
  return 'потолок плана не задан'
}
