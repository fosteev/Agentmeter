/**
 * Второй источник лимитов Codex: ответ `backend-api/wham/usage` (6.4).
 *
 * Первый источник — сами роллауты: Codex кладёт `rate_limits` в каждый
 * `token_count`, и проценты там точные (пункт 8). Но написаны они **в момент
 * запроса**, а значит отвечают на вопрос «сколько было израсходовано, когда я
 * последний раз работал», а не «сколько сейчас». Разница измерена: 10 августа
 * лог сообщал 44% недельного окна со сбросом 14 августа, а 12 августа тот же
 * аккаунт по ответу провайдера стоял на нуле. Показывать в такой ситуации 44%
 * — врать на всю величину.
 *
 * Второе, что даёт этот источник, — тот же довод, что у Claude в 6.3: лимит
 * считается **по аккаунту**, а роллауты знают одну машину. Расход из веба, с
 * другого компьютера и из облачных задач в логи не попадает вовсе.
 *
 * Здесь только чистое: разбор `~/.codex/auth.json`, разбор срока жизни токена и
 * разбор тела ответа в окна. Сеть, кэш и решение «пора ли спрашивать» живут в
 * [`main/codex-oauth.ts`](../../../../apps/desktop/src/main/codex-oauth.ts) — по
 * той же причине, по какой они там у Claude: попап и главное окно обязаны
 * ходить в сеть один раз на двоих.
 *
 * Ограничение окна (429) и `Retry-After` не дублируются, а берутся из
 * [`oauth.ts`](./oauth.ts): формат заголовка стандартный, и второй его разбор
 * означал бы две правды об одном.
 */
import type { LimitWindow } from '../sources/types.ts'
import { kindForMinutes } from './windows.ts'

/** Куда ходим. Тот же путь, каким ходит сам Codex CLI за состоянием лимитов. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/**
 * Сколько живёт снимок. Столько же, сколько у Claude, и по той же причине:
 * недельное окно двигается часами, а четыре запроса в час — то, за что не
 * стыдно перед чужим сервером.
 */
export const CODEX_SNAPSHOT_TTL_MS = 15 * 60_000

const MINUTE_MS = 60_000

/** Что удалось прочитать из `~/.codex/auth.json`. */
export interface CodexCredentials {
  token: string
  /** Заголовок `ChatGPT-Account-Id`. Отсутствует у части файлов — не ошибка. */
  accountId?: string
  /** `exp` из тела токена, мс. Отсутствует — срок не прочитан, см. `codexTokenExpired`. */
  expiresAt?: number
}

/**
 * `~/.codex/auth.json` → токен доступа.
 *
 * Берётся только ветка OAuth (`tokens.access_token`). Вход по ключу API
 * (`OPENAI_API_KEY` без `tokens`) сюда не годится принципиально: у ключа нет ни
 * плана, ни окон подписки, и эндпоинт отвечает на него отказом — то есть
 * «креденшелов нет» тут честнее, чем «есть, но не подошли».
 *
 * `refresh_token` не читается **намеренно**, и это главное расхождение с
 * ClaudeBar, откуда взят сам эндпоинт. Тот при старом `last_refresh` идёт на
 * `auth.openai.com/oauth/token` и переписывает `auth.json` своим ответом.
 * У OpenAI refresh-токены одноразовые: наш обмен обесценивает тот, что лежит у
 * Codex CLI, и следующий его собственный рефреш получает `refresh_token_reused`
 * — то есть цена нашей ошибки здесь не «лимиты не показались», а «человека
 * разлогинило из Codex». Токен обновляет тот, кто им работает; мы читаем.
 */
export function parseCodexCredentials(raw: string): CodexCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined
  const tokens = parsed['tokens']
  if (!isObject(tokens)) return undefined
  const token = tokens['access_token']
  if (typeof token !== 'string' || token === '') return undefined

  const credentials: CodexCredentials = { token }
  const accountId = tokens['account_id']
  if (typeof accountId === 'string' && accountId !== '') credentials.accountId = accountId
  const expiresAt = tokenExpiry(token)
  if (expiresAt !== undefined) credentials.expiresAt = expiresAt
  return credentials
}

/**
 * Срок жизни токена из его же полезной нагрузки.
 *
 * Подпись не проверяется, и проверять её здесь нечем и незачем: вопрос не «свой
 * ли это токен», а «стоит ли вообще стучаться». Единственный потребитель ответа
 * — решение не ходить в сеть с заведомо мёртвым токеном и сказать человеку
 * «токен просрочен, запустите codex» вместо «OpenAI не принял токен»: советы
 * разные, а 401 их не различает.
 */
function tokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined || payload === '') return undefined
  let decoded: string
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
  let claims: unknown
  try {
    claims = JSON.parse(decoded)
  } catch {
    return undefined
  }
  if (!isObject(claims)) return undefined
  const exp = finite(claims['exp'])
  return exp !== undefined && exp > 0 ? exp * 1000 : undefined
}

/**
 * Токен заведомо мёртв.
 *
 * Нечитаемый срок — **не** просроченный. Отказ от запроса из-за того, что мы не
 * разобрали чужой формат, выключил бы источник целиком и молча; в спорном
 * случае идём в сеть и слушаем провайдера.
 */
export function codexTokenExpired(credentials: CodexCredentials, now: number): boolean {
  return credentials.expiresAt !== undefined && credentials.expiresAt <= now
}

/**
 * Тело ответа → окна лимита.
 *
 * Пустой список означает «записывать нечего»: ни одного окна с процентом и
 * границей в ответе не нашлось. Это не ошибка — так выглядит и аккаунт без
 * активных лимитов (`rate_limit: null`), и ответ, в котором все окна оказались
 * непригодны.
 *
 * Разбирается **только** `rate_limit`. Рядом в ответе лежат
 * `code_review_rate_limit` и `additional_rate_limits` — другие пулы со своими
 * потолками, и взять их в тот же список значит показать два недельных окна
 * Codex с разными процентами: `LimitWindow` различает окна длиной, а не
 * происхождением, и на экране они станут неразличимы.
 */
export function parseCodexUsage(raw: unknown, ts: number): LimitWindow[] {
  if (!isObject(raw)) return []
  const rateLimit = raw['rate_limit']
  if (!isObject(rateLimit)) return []

  const windows: LimitWindow[] = []
  for (const slot of ['primary_window', 'secondary_window'] as const) {
    const window = codexWindow(rateLimit[slot], ts)
    if (window) windows.push(window)
  }
  return windows
}

/**
 * Одно окно ответа → `LimitWindow`.
 *
 * **Вид окна — из его длины, а не из имени слота**, и это не вкус, а пункт 8
 * CLAUDE.md, подтверждённый живым ответом 12 августа: недельное окно приехало в
 * `primary_window`, а `secondary_window` был пуст. Разбор по слотам показал бы
 * недельный расход как пятичасовой — молча и правдоподобно.
 *
 * Отсюда же правило про окно **без** `limit_window_seconds`: оно выпадает
 * целиком. Подставить пять часов «потому что это primary» — та же ошибка с
 * другого конца, а без длины не выводится ни вид, ни начало окна.
 */
function codexWindow(raw: unknown, ts: number): LimitWindow | undefined {
  if (!isObject(raw)) return undefined

  const seconds = finite(raw['limit_window_seconds'])
  if (seconds === undefined || seconds <= 0) return undefined
  const windowMinutes = Math.round(seconds / 60)

  // Процент вне 0…100 роняет своё окно, а не ответ: соседнее от этого не
  // становится неверным. Отсутствие процента — тоже отказ, а не ноль: ноль
  // здесь означал бы «израсходовано ноль», а это другое утверждение.
  const usedPercent = finite(raw['used_percent'])
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return undefined

  const resetsAt = resetMs(raw, ts)
  if (resetsAt === undefined) return undefined

  return {
    provider: 'codex',
    kind: kindForMinutes(windowMinutes),
    windowMinutes,
    startsAt: resetsAt - windowMinutes * MINUTE_MS,
    resetsAt,
    usedPercent,
    // Момент **наблюдения**, а не последнего запроса: процент снят сейчас, и
    // возраст ответа человек видит рядом с кнопкой «спросить».
    observedAt: ts,
    exact: true,
  }
}

/**
 * Момент сброса: `reset_at` в секундах, иначе `reset_after_seconds` от `ts`.
 *
 * Порядок именно такой — абсолютное время точнее относительного, у которого к
 * моменту разбора уже накопилась задержка запроса. Отсчёт относительного идёт
 * от времени нашего наблюдения: другого времени в теле нет вовсе.
 *
 * Оговорка, которую видно только на живом ответе: при нулевом проценте
 * `reset_at` приходит равным `ts + limit_window_seconds` до секунды, то есть
 * границы у окна ещё нет и провайдер отдаёт заглушку. Мы берём её как есть —
 * «окно свежее, израсходовано ноль» и есть то, что он говорит.
 */
function resetMs(raw: Record<string, unknown>, ts: number): number | undefined {
  const at = finite(raw['reset_at'])
  if (at !== undefined && at > 0) return at * 1000
  const after = finite(raw['reset_after_seconds'])
  if (after !== undefined && after >= 0) return ts + after * 1000
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
