/**
 * Лимиты Codex по требованию: запрос к `backend-api/wham/usage` (6.4).
 *
 * Второй источник тех же процентов, что лежат в роллаутах, и нужен он потому,
 * что первый отвечает на другой вопрос: в логе процент написан **в момент
 * запроса**. Замер: 10 августа лог сообщал 44% недельного окна со сбросом 14-го,
 * 12 августа тот же аккаунт по ответу провайдера стоял на нуле. Плюс довод
 * 6.3 — лимит считается по аккаунту, а роллауты знают одну машину.
 *
 * **Это третий и последний сетевой вызов продукта.** Правила те же, что у
 * соседнего источника ([`oauth.ts`](./oauth.ts)), и ослаблять их нельзя:
 *
 * 1. Выключено по умолчанию. Пока `limits.codex.api.enabled` не включён
 *    человеком, отсюда не уходит ни одного запроса.
 * 2. Токен только читается. `~/.codex/auth.json` не переписывается, рефреша
 *    нет, `auth.openai.com` не трогается вовсе — и это главное расхождение с
 *    ClaudeBar, откуда взят эндпоинт. У OpenAI refresh-токены одноразовые: наш
 *    обмен обесценил бы тот, что лежит у Codex CLI, и следующий его собственный
 *    рефреш получил бы `refresh_token_reused`. Цена такой ошибки — не «лимиты
 *    не показались», а «человека разлогинило из Codex».
 * 3. Токен не выходит за пределы этого файла: наружу уходят проценты и наш
 *    короткий пересказ ошибки.
 *
 * Разбор файла, срока жизни токена и тела ответа лежит в
 * [`limits/codex-oauth.ts`](../../../../packages/core/src/limits/codex-oauth.ts).
 * Здесь — эффекты: чтение файла, запрос, кэш.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODEX_SNAPSHOT_TTL_MS,
  CODEX_USAGE_URL,
  codexTokenExpired,
  parseCodexCredentials,
  parseCodexUsage,
  t,
  throttleFrom,
  throttled,
  type CodexCredentials,
  type LimitWindow,
  type Throttle,
} from '@agentmeter/core'
import type { CodexApiStatus } from '@agentmeter/ipc'
import type { OauthFetch } from './oauth.ts'

/** Что модулю нужно от машины. Как у `OauthHost` — пути, а не `app`. */
export interface CodexOauthHost {
  /** Каталог настроек Codex: там `auth.json`. */
  codexHome: string
  /**
   * Как сходить в сеть. Обязан быть **`net.fetch` из Electron**, а не `fetch`
   * из Node, и это замер, а не осторожность: перед `chatgpt.com/backend-api`
   * стоит Cloudflare, отсекающий Node по отпечатку TLS. Один и тот же токен,
   * одни и те же заголовки, 12 августа: `curl` — 200, `fetch` из Node — 403 с
   * html-страницей блокировки вместо JSON. Ровно то же, что на
   * `api.anthropic.com` в 6.3 (пункт 23), и опасно тем же: с Node-фетчем
   * источник не заработал бы ни у кого, а выглядело бы это как «OpenAI не
   * принял токен».
   */
  fetch: OauthFetch
}

/** Живое состояние источника: кэш окон и окно ограничения. */
export interface CodexOauthState {
  /** Последний удачный ответ, разобранный в окна. */
  windows?: LimitWindow[]
  fetchedAt?: number
  throttle?: Throttle
  needsLogin: boolean
  problem?: string
}

export function openCodexOauth(): CodexOauthState {
  return { needsLogin: false }
}

/**
 * Где лежит токен и какой он.
 *
 * Ветка одна, в отличие от Claude: у Codex нет ни Keychain, ни второго места —
 * всё в `~/.codex/auth.json`, включая macOS. Поэтому `expired` здесь отдельным
 * значением, а не подвидом `missing`: «токен есть, но протух» лечится запуском
 * `codex`, а «токена нет» — входом в него, и это разные советы.
 */
export function readCodexToken(
  host: CodexOauthHost,
  now: number,
): { credentials?: CodexCredentials; from: CodexApiStatus['credentials'] } {
  let raw: string
  try {
    raw = readFileSync(join(host.codexHome, 'auth.json'), 'utf8')
  } catch {
    return { from: 'missing' }
  }
  const credentials = parseCodexCredentials(raw)
  if (credentials === undefined) return { from: 'missing' }
  if (codexTokenExpired(credentials, now)) return { credentials, from: 'expired' }
  return { credentials, from: 'file' }
}

/**
 * Спросить проценты.
 *
 * Возвращаются окна, если ответ новый, иначе `null` — «есть ли повод пересчитать
 * снимок», а не «сходили ли мы». Журнала здесь нет и не будет: журнал 1.9 копит
 * наблюдения ради калибровки веса `cache_read` **у Claude**, у Codex этот вес
 * измерен подбором (≈ 0.2, пункт 7), и чужие проценты в той выборке — прямой
 * способ испортить решение линейной системы.
 *
 * Сеть трогается только когда: настройка включена, кэш протух, окно ограничения
 * истекло и 401 не приходил. `force` (кнопка) снимает только кэш: кнопка не
 * должна уметь ломать чужой запрет.
 */
export async function pollCodexOauth(
  host: CodexOauthHost,
  state: CodexOauthState,
  options: { enabled: boolean; force?: boolean; now?: number } = { enabled: false },
): Promise<LimitWindow[] | null> {
  const now = options.now ?? Date.now()
  if (!options.enabled) return null
  if (throttled(state.throttle, now)) return null
  if (state.needsLogin && options.force !== true) return null
  if (!options.force && state.fetchedAt !== undefined && now - state.fetchedAt < CODEX_SNAPSHOT_TTL_MS) {
    return null
  }

  const { credentials, from } = readCodexToken(host, now)
  if (credentials === undefined) {
    state.problem = t('codexOauth.noCredentials')
    return null
  }
  if (from === 'expired') {
    // Запроса с заведомо мёртвым токеном не будет: 401 мы и так получим, а
    // сказать «токен просрочен» можно и без похода в сеть.
    state.problem = t('codexOauth.expired')
    return null
  }

  let response: Response
  try {
    response = await host.fetch(CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credentials.token}`,
        accept: 'application/json',
        ...(credentials.accountId === undefined
          ? {}
          : { 'chatgpt-account-id': credentials.accountId }),
        // Свой, а не `codex_cli_rs/<версия>`: 200 приходит и так (проверено), а
        // врать провайдеру о том, кто стучится, в продукте про честность цифр —
        // плохая цена за ничто.
        'user-agent': 'Agentmeter',
      },
    })
  } catch {
    // Сети нет, DNS не отвечает, прокси отказал. Прежние окна при этом остаются
    // на экране: «не дозвонились» — не то же самое, что «лимит неизвестен».
    state.problem = t('codexOauth.offline')
    return null
  }

  if (response.status === 401 || response.status === 403) {
    state.needsLogin = true
    state.problem = t('codexOauth.needsLogin')
    return null
  }
  if (response.status === 429) {
    state.throttle = throttleFrom(response.headers.get('retry-after'), now)
    state.problem = t('codexOauth.throttled')
    return null
  }
  if (!response.ok) {
    // Код — единственное, что отсюда уходит наружу: тело человеку не
    // показываем, в нём бывает и эхо запроса.
    state.problem = t('codexOauth.httpError', { status: response.status })
    return null
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    state.problem = t('codexOauth.badBody')
    return null
  }

  const windows = parseCodexUsage(body, now)
  state.fetchedAt = now
  state.needsLogin = false
  delete state.problem
  delete state.throttle
  if (windows.length === 0) {
    // Ответ разобрался, окон в нём нет. Так выглядит аккаунт без активных
    // лимитов — не ошибка, но и заменять наши окна нечем. Прежние остаются:
    // пустой ответ не отменяет прошлого наблюдения.
    return null
  }

  state.windows = windows
  return windows
}

/** Строка раздела настроек: включено ли, откуда токен, что вышло. */
export function codexOauthStatus(
  host: CodexOauthHost,
  state: CodexOauthState,
  enabled: boolean,
  now: number = Date.now(),
): CodexApiStatus {
  const status: CodexApiStatus = {
    enabled,
    // Выключенная настройка не оправдывает чтения чужого файла с токеном.
    credentials: enabled ? readCodexToken(host, now).from : 'missing',
    needsLogin: state.needsLogin,
  }
  if (state.fetchedAt !== undefined) status.fetchedAt = state.fetchedAt
  if (state.windows !== undefined) {
    status.windows = state.windows.map((window) => ({
      kind: window.kind,
      windowMinutes: window.windowMinutes,
      // Процент здесь всегда число: окна без процента разбор не возвращает.
      pct: window.usedPercent ?? 0,
    }))
  }
  if (state.throttle !== undefined) status.retryAt = state.throttle.retryAt
  if (state.problem !== undefined) status.problem = state.problem
  return status
}
