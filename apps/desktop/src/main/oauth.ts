/**
 * Лимиты по требованию: запрос к `/api/oauth/usage` (6.3).
 *
 * Второй источник тех же процентов, что даёт хук строки состояния (1.9), и
 * нужен он потому, что первый работает не везде: `statusLine` — фича
 * терминального TUI, в VS Code-расширении её нет, команда не зовётся, журнал
 * остаётся пустым навсегда. Здесь те же числа берутся оттуда, откуда их берёт
 * сам Claude Code.
 *
 * **Это второй и последний сетевой вызов продукта, и единственный, который
 * идёт креденшелами Claude Code.** Отсюда правила, которые ослаблять нельзя:
 *
 * 1. Выключено по умолчанию. Пока `limits.claude.api.enabled` не включён
 *    человеком, отсюда не уходит ни одного запроса — ни при старте, ни по
 *    таймеру, ни при открытии настроек.
 * 2. Токен только читается. Рефреша нет, записи в Keychain нет,
 *    `platform.claude.com` не трогается вовсе: токен обновляет сам Claude Code,
 *    а наш неудачный рефреш мог бы выбить человека из CLI.
 * 3. Токен не выходит за пределы этого файла. Ни в лог, ни в `problem`, ни в
 *    IPC — наружу уходят проценты и наш короткий пересказ ошибки.
 *
 * Разбор ответа, `Retry-After` и решение «можно ли стучаться» лежат в
 * [`limits/oauth.ts`](../../../../packages/core/src/limits/oauth.ts) ядра.
 * Здесь — эффекты: чтение файла и Keychain, запрос, кэш, дозапись журнала.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OAUTH_BETA_HEADER,
  OAUTH_USAGE_URL,
  SNAPSHOT_TTL_MS,
  appendUsageJournal,
  parseCredentials,
  parseOauthUsage,
  t,
  throttleFrom,
  throttled,
  usageKeys,
  type Throttle,
  type UsageSnapshot,
} from '@agentmeter/core'
import type { UsageApiStatus } from '@agentmeter/ipc'
import type { UsageJournal } from './statusline.ts'

/** Чем ходим в сеть: строка и заголовки, ничего сверх. */
export type OauthFetch = (input: string, init?: RequestInit) => Promise<Response>

/** Что модулю нужно от машины. Как у `StatuslineHost` — пути, а не `app`. */
export interface OauthHost {
  /** Каталог настроек Claude Code: там `.credentials.json`. */
  claudeHome: string
  platform: NodeJS.Platform
  /**
   * Как сходить в сеть. Параметром, а не прямым `fetch`, по двум причинам.
   *
   * Первая — проверяемость: при выключенной настройке сюда подставляется
   * функция, которая считает вызовы, и зелёный тест означает, что вызова не
   * было. Проверить «мы не пошли в сеть» иначе нечем.
   *
   * Вторая важнее и обнаружена замером. Приложение обязано передавать сюда
   * **`net.fetch` из Electron**, а не `globalThis.fetch` из Node: на
   * `/api/oauth/usage` стоит Cloudflare, отсекающий Node по отпечатку TLS. Один
   * и тот же токен, одни и те же заголовки, 11 августа: `curl` — 200,
   * Chromium — 200, `fetch` из Node — 403, `node:https` — 403, `node:http2` —
   * 403. Дело не в заголовках и не в версии протокола, обе проверены порознь.
   *
   * Тип свой, а не `typeof globalThis.fetch`: тот принимает ещё и `URL`, а
   * `net.fetch` — только строку и `Request`, и под широкий тип он не подходит.
   * Строки нам достаточно.
   */
  fetch: OauthFetch
  /**
   * Чем читать Keychain. Тоже параметром: на машине без Keychain (Windows,
   * Linux, CI) ветка иначе не проверялась бы вовсе.
   */
  keychain?: () => string | undefined
}

/** Живое состояние источника. Кэш снимка и окно ограничения живут здесь. */
export interface OauthState {
  /** Последний удачный снимок и когда он получен. */
  snapshot?: UsageSnapshot
  fetchedAt?: number
  throttle?: Throttle
  needsLogin: boolean
  problem?: string
}

export function openOauth(): OauthState {
  return { needsLogin: false }
}

/**
 * Где лежит токен и какой он.
 *
 * Порядок — файл, потом Keychain, и это не алфавит: файл `.credentials.json`
 * пишет `claude login` на Linux и в старых сборках, Keychain — текущий macOS.
 * На замеренной машине файла нет вовсе, всё в Keychain, — то есть вторая ветка
 * основная, а не запасная.
 *
 * Токен возвращается вместе с тем, откуда он взялся: экран настроек показывает
 * источник, и «токен не найден» отличается от «токен найден, но отвергнут»
 * ровно этим полем.
 */
export function readToken(host: OauthHost): { token?: string; from: UsageApiStatus['credentials'] } {
  try {
    const token = parseCredentials(readFileSync(join(host.claudeHome, '.credentials.json'), 'utf8'))
    if (token !== undefined) return { token, from: 'file' }
  } catch {
    // Файла нет — обычное дело на macOS, там всё в Keychain. Не ошибка.
  }

  const raw = (host.keychain ?? defaultKeychain(host.platform))()
  if (raw === undefined) return { from: 'missing' }
  const token = parseCredentials(raw)
  return token === undefined ? { from: 'missing' } : { token, from: 'keychain' }
}

/**
 * Чтение Keychain через `security`, а не через нативный модуль.
 *
 * Нативный биндинг к Security.framework пришлось бы собирать под обе
 * архитектуры и пересобирать под каждую версию Electron — ради одной строки,
 * которую системная утилита отдаёт сама. Вывод — тот же JSON, что в
 * `.credentials.json`.
 */
function defaultKeychain(platform: NodeJS.Platform): () => string | undefined {
  if (platform !== 'darwin') return () => undefined
  return () => {
    try {
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      // Записи нет, доступ не дан, диалог отклонён — все три случая означают
      // одно: токена у нас нет. Разбирать их по коду возврата нечем, `security`
      // возвращает 44 и 128 вперемешку.
      return undefined
    }
  }
}

/**
 * Спросить проценты и дописать журнал.
 *
 * Возвращается снимок, если он новый, иначе `null` — как у `drainSnapshot`
 * соседнего источника, и по той же причине: вызывающему интересно «есть ли
 * повод пересчитать», а не «сходили ли мы».
 *
 * Сеть трогается только когда: настройка включена, кэш протух, окно
 * ограничения истекло и 401 не приходил. Порядок проверок именно такой —
 * дешёвые сначала, и `force` (кнопка в настройках) снимает только кэш, но не
 * ограничение и не 401: кнопка не должна уметь ломать чужой запрет.
 */
export async function pollOauth(
  host: OauthHost,
  state: OauthState,
  journal: UsageJournal,
  options: { enabled: boolean; force?: boolean; now?: number } = { enabled: false },
): Promise<UsageSnapshot | null> {
  const now = options.now ?? Date.now()
  if (!options.enabled) return null
  if (throttled(state.throttle, now)) return null
  if (state.needsLogin && options.force !== true) return null
  if (!options.force && state.fetchedAt !== undefined && now - state.fetchedAt < SNAPSHOT_TTL_MS) {
    return null
  }

  const { token } = readToken(host)
  if (token === undefined) {
    state.problem = t('oauth.noCredentials')
    return null
  }

  let response: Response
  try {
    response = await host.fetch(OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'anthropic-beta': OAUTH_BETA_HEADER,
        // Свой, а не `claude-code/<версия>`: ответ 200 приходит и так
        // (проверено), а врать провайдеру о том, кто стучится, в продукте про
        // честность цифр — плохая цена за ничто.
        'user-agent': 'Agentmeter',
      },
    })
  } catch {
    // Сети нет, DNS не отвечает, прокси отказал. Прежний снимок при этом
    // остаётся на экране: «не дозвонились» — не то же самое, что «лимит
    // неизвестен».
    state.problem = t('oauth.offline')
    return null
  }

  if (response.status === 401 || response.status === 403) {
    state.needsLogin = true
    state.problem = t('oauth.needsLogin')
    return null
  }
  if (response.status === 429) {
    state.throttle = throttleFrom(response.headers.get('retry-after'), now)
    state.problem = t('oauth.throttled')
    return null
  }
  if (!response.ok) {
    // Код — единственное, что отсюда уходит наружу: тело ответа человеку не
    // показываем, в нём бывает и эхо запроса.
    state.problem = t('oauth.httpError', { status: response.status })
    return null
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    state.problem = t('oauth.badBody')
    return null
  }

  const snapshot = parseOauthUsage(body, now)
  if (snapshot === null) {
    // Ответ разобрался, окон с границей в нём нет. Так выглядит аккаунт без
    // активных лимитов — не ошибка, но и записывать нечего.
    state.fetchedAt = now
    delete state.problem
    return null
  }

  state.snapshot = snapshot
  state.fetchedAt = now
  state.needsLogin = false
  delete state.problem
  delete state.throttle

  // Дедуп общий с журналом строки состояния: пара (процент, момент сброса)
  // одинакова у обоих источников, и одно и то же наблюдение, пришедшее двумя
  // путями, обязано лечь в журнал один раз.
  const keys = usageKeys(snapshot)
  if (keys.every((key) => journal.seen.has(key))) return null
  appendUsageJournal(journal.path, [snapshot])
  for (const key of keys) journal.seen.add(key)
  journal.snapshots.push(snapshot)
  return snapshot
}

/** Строка раздела настроек: включено ли, откуда токен, что вышло. */
export function oauthStatus(host: OauthHost, state: OauthState, enabled: boolean): UsageApiStatus {
  const status: UsageApiStatus = {
    enabled,
    // Выключенная настройка не оправдывает похода в Keychain: там системный
    // диалог доступа, и вызывать его ради серой строки на экране нельзя.
    credentials: enabled ? readToken(host).from : 'missing',
    needsLogin: state.needsLogin,
  }
  if (state.fetchedAt !== undefined) status.fetchedAt = state.fetchedAt
  if (state.snapshot?.fiveHour) status.fiveHourPct = state.snapshot.fiveHour.pct
  if (state.snapshot?.weekly) status.weeklyPct = state.snapshot.weekly.pct
  if (state.throttle !== undefined) status.retryAt = state.throttle.retryAt
  if (state.problem !== undefined) status.problem = state.problem
  return status
}
