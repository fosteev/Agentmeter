/**
 * Второй источник настоящих лимитов Claude: ответ `/api/oauth/usage` (6.3).
 *
 * Первый источник — хук строки состояния (1.9) — работает только там, где эта
 * строка рисуется. В VS Code-расширении её нет, команда не зовётся, и журнал
 * наблюдений остаётся пустым **навсегда**, а не «копится медленно»: замер на
 * машине автора — хук установлен и исправен, `usage-latest.json` не появился за
 * 7.5 часа. Отсюда этот файл.
 *
 * Здесь только чистое: разбор тела ответа, разбор `Retry-After`, разбор вывода
 * `security` и решение, когда можно снова стучаться. Сеть, таймеры, Keychain и
 * кэш живут в [`main/oauth.ts`](../../../../apps/desktop/src/main/oauth.ts) —
 * иначе у попапа и главного окна оказалось бы по своему кэшу, и они сходили бы
 * в сеть порознь.
 *
 * **Проценты тут целые.** `five_hour.utilization` приезжает как `19.0`, а в
 * массиве `limits` то же число лежит как `percent: 19`. Это тот самый дефект,
 * из-за которого отвергнут `cachedUsageUtilization` (1.9, пункт 3), и не
 * случайно: сверка 11 августа показала, что в `~/.claude.json` лежит **то же
 * тело**, поле в поле. Разница между источниками одна — свежесть. Поэтому
 * снимок помечается `source: 'oauth'`, а калибровка берёт его с порогом
 * `CALIBRATION.minIntegerPct`: квантование ±0.5 п.п. при `p = 5` хватает, чтобы
 * увести потолок и заблокировать всю калибровку (эталон —
 * `fixtures/usage/expected-oauth.json`).
 */
import type { UsageSnapshot, UsageWindowSample } from './usage.ts'

/** Куда ходим. Заголовок беты обязателен, без него эндпоинт отвечает 401. */
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * Сколько живёт полученный снимок.
 *
 * Пятичасовое и недельное окна двигаются часами, так что четверть часа ничего
 * не стоит по свежести и снимает почти весь риск упереться в ограничение:
 * опрос раз в минуту превратился бы в 60 запросов в час, а так их четыре.
 */
export const SNAPSHOT_TTL_MS = 15 * 60_000

/**
 * На сколько замолкаем, когда 429 пришёл без пригодного `Retry-After`.
 *
 * Пять минут — не осторожность ради осторожности: ClaudeBar документирует
 * часовые окна в ответ на единственный запрос после паузы
 * (anthropics/claude-code#30930), и слишком короткая пауза здесь означает
 * бесконечный цикл «спросили — получили отказ — спросили».
 */
export const DEFAULT_RETRY_MS = 5 * 60_000

/** Окно ограничения: до этого момента запросов нет. */
export interface Throttle {
  retryAt: number
}

/**
 * `Retry-After` → сколько миллисекунд молчать.
 *
 * По RFC 7231 значение — либо неотрицательное целое секунд, либо HTTP-дата.
 * Возвращается `undefined` на всё, чему нельзя верить, и вызывающий подставляет
 * `DEFAULT_RETRY_MS`.
 *
 * **Ноль отбраковывается намеренно.** Эндпоинт наблюдался отдающим
 * `Retry-After: 0` и продолжающим отказывать; «ноль значит можно сразу»
 * возвращает нас в тот же цикл, из-за которого заголовок и появился.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined

  // Именно целое: `Number('5 minutes')` даёт NaN, а вот `Number('5.9')` — 5.9,
  // и секунды с дробью здесь означали бы, что мы неправильно поняли формат.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return seconds > 0 ? seconds * 1000 : undefined
  }

  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  const delta = at - now
  return delta > 0 ? delta : undefined
}

/** Ответ 429 → до какого момента молчим. */
export function throttleFrom(retryAfter: string | null | undefined, now: number): Throttle {
  return { retryAt: now + (parseRetryAfter(retryAfter, now) ?? DEFAULT_RETRY_MS) }
}

/** Окно ограничения ещё действует. Истёкшее окно — то же самое, что его отсутствие. */
export function throttled(throttle: Throttle | undefined, now: number): boolean {
  return throttle !== undefined && throttle.retryAt > now
}

/**
 * Тело ответа → снимок журнала.
 *
 * Разбирается **массив `limits`**, а не именованные поля. Рядом с `five_hour` и
 * `seven_day` в ответе лежат `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_cowork` и полдюжины кодовых имён (`tangelo`, `iguana_necktie`,
 * `nimbus_quill`, `cinder_cove`, `amber_ladder`) — чужие эксперименты, которые
 * появляются и исчезают. Массив ту же информацию размечает сам: `kind`
 * говорит, что это за окно, и незнакомое имя пропускается молча вместо того,
 * чтобы ронять разбор.
 *
 * `null` означает «записывать нечего»: ни одного окна с границей в ответе не
 * нашлось. Это не ошибка — так выглядит ответ аккаунту без активных лимитов.
 */
export function parseOauthUsage(raw: unknown, ts: number): UsageSnapshot | null {
  if (!isObject(raw)) return null
  const limits = raw['limits']
  if (!Array.isArray(limits)) return null

  const snapshot: UsageSnapshot = { ts, sessionId: '', source: 'oauth' }
  for (const entry of limits) {
    if (!isObject(entry)) continue
    // `weekly_scoped` (модельное окно) сюда не попадает намеренно: `UsageWindowKind`
    // — часть контракта 1.9, и расширять его ради окна, которое на замеренном
    // аккаунте всегда неактивно, значит менять контракт под догадку.
    const kind = entry['kind'] === 'session' ? 'fiveHour' : entry['kind'] === 'weekly_all' ? 'weekly' : undefined
    if (kind === undefined || snapshot[kind] !== undefined) continue
    const sample = windowSample(entry['percent'], entry['resets_at'])
    if (sample) snapshot[kind] = sample
  }

  return snapshot.fiveHour || snapshot.weekly ? snapshot : null
}

/**
 * Процент и момент сброса одной записи.
 *
 * Запись без `resets_at` пропускается: модель 1.9 считает расход **внутри
 * окна**, а окно без границы интервала не задаёт. В живом ответе такие есть —
 * `nimbus_quill` стоит нулём с `resets_at: null`.
 *
 * Процент вне 0…100 роняет запись, а не весь ответ: соседние окна от этого не
 * становятся неверными.
 */
function windowSample(rawPct: unknown, rawResets: unknown): UsageWindowSample | undefined {
  const pct = finite(rawPct)
  if (pct === undefined || pct < 0 || pct > 100) return undefined
  const resetsAt = parseIsoMs(rawResets)
  if (resetsAt === undefined) return undefined
  return { pct, resetsAt }
}

/**
 * ISO 8601 с зоной → миллисекунды.
 *
 * Формат здесь другой, чем у строки состояния: там `resets_at` приезжает
 * числом секунд, тут — строкой вида `2026-08-16T05:00:00.668875+00:00`, с
 * микросекундами. В журнал и там и там ложатся миллисекунды (шапка
 * [`usage.ts`](./usage.ts)), и микросекунды `Date.parse` отбрасывает сам.
 */
function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) && at > 0 ? at : undefined
}

/**
 * Вывод `security find-generic-password -s "Claude Code-credentials" -w` или
 * содержимое `~/.claude/.credentials.json` → токен доступа.
 *
 * Форма одна и та же: `claudeAiOauth.accessToken`. На замеренной машине файла
 * нет вовсе, всё лежит в Keychain, — то есть ветка Keychain основная, а не
 * запасная.
 *
 * Ни срок жизни токена, ни `refreshToken` отсюда не возвращаются, и это
 * решение, а не упущение: рефреша у нас нет. Токен обновляет сам Claude Code,
 * а работающий Claude Code — предусловие всего продукта. Наш неудачный рефреш
 * мог бы выбить человека из CLI; неудача чтения стоит одной серой строки на
 * экране.
 */
export function parseCredentials(raw: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined
  const oauth = parsed['claudeAiOauth']
  if (!isObject(oauth)) return undefined
  const token = oauth['accessToken']
  return typeof token === 'string' && token !== '' ? token : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
