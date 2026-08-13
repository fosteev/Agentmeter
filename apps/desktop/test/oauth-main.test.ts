import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@agentmeter/core'
import { oauthStatus, openOauth, pollOauth, readToken, type OauthHost } from '../src/main/oauth.ts'
import { openJournal } from '../src/main/usage.ts'

/**
 * Второй источник лимитов в main (6.3): токен, запрос, кэш, журнал.
 *
 * Проверки названы поломкой, которую ловят, и главная из них первая: при
 * выключенной настройке запроса не уходит вовсе. Держится она на **счётчике
 * вызовов**, а не на падающем `fetch`, и это разница по существу: `pollOauth`
 * ловит ошибку сети сам — обрыв связи не должен ронять трей, — так что
 * брошенное исключение он честно превратит в «не дозвонились», и тест на нём
 * пережил бы удаление проверки настройки. Так и вышло при прогоне мутаций.
 */

let dir: string
let host: { claudeHome: string; configDir: string; platform: NodeJS.Platform }
let journal: ReturnType<typeof openJournal>

/**
 * `fetch`, который считает вызовы и падает.
 *
 * Считает — потому что падения мало: `pollOauth` ловит ошибку сети сам (обрыв
 * связи не должен ронять трей), и брошенное исключение он превратит в «не
 * дозвонились». Проверка «мы не пошли в сеть» держится на счётчике, а не на
 * исключении, — мутация «выключенная настройка всё равно ходит» проходила
 * мимо теста ровно из-за этого.
 */
function forbidden(): { fetch: typeof globalThis.fetch; calls: number } {
  const box = {
    calls: 0,
    fetch: (() => {
      box.calls += 1
      throw new Error('в сеть ходить не должны были')
    }) as typeof globalThis.fetch,
  }
  return box
}

/** Ответ, который отдаёт подменённый `fetch`. */
function replying(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; headers: Headers }> } {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    )
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const live = JSON.parse(
  readFileSync(new URL('../../../fixtures/oauth/usage-live.json', import.meta.url), 'utf8'),
) as unknown

function withToken(fetch: typeof globalThis.fetch): OauthHost {
  return { claudeHome: host.claudeHome, platform: 'darwin', fetch, keychain: () => KEYCHAIN }
}

const KEYCHAIN = readFileSync(
  new URL('../../../fixtures/oauth/credentials-keychain.json', import.meta.url),
  'utf8',
)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-oauth-'))
  setLocale('ru')
  host = { claudeHome: join(dir, 'claude'), configDir: join(dir, 'config'), platform: 'darwin' }
  mkdirSync(host.claudeHome, { recursive: true })
  journal = openJournal(host)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('выключенная настройка', () => {
  it('не даёт уйти ни одному запросу', async () => {
    const state = openOauth()
    const net = forbidden()
    await expect(
      pollOauth(withToken(net.fetch), state, journal, { enabled: false }),
    ).resolves.toBeNull()
    expect(net.calls).toBe(0)
    expect(state.fetchedAt).toBeUndefined()
  })

  it('не заглядывает и в связку ключей: там системный диалог доступа', () => {
    let asked = 0
    const host2: OauthHost = {
      claudeHome: host.claudeHome,
      platform: 'darwin',
      fetch: forbidden().fetch,
      keychain: () => {
        asked += 1
        return KEYCHAIN
      },
    }
    const status = oauthStatus(host2, openOauth(), false)
    expect(asked).toBe(0)
    expect(status.credentials).toBe('missing')
  })
})

describe('токен', () => {
  it('файл сильнее связки ключей: там он лежит у `claude login` вне macOS', () => {
    writeFileSync(
      join(host.claudeHome, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'из-файла' } }),
    )
    expect(readToken(withToken(forbidden().fetch))).toEqual({ token: 'из-файла', from: 'file' })
  })

  it('без файла берётся из связки ключей — на macOS это основной путь', () => {
    expect(readToken(withToken(forbidden().fetch)).from).toBe('keychain')
  })

  it('без токена запрос не делается вовсе', async () => {
    const net = forbidden()
    const bare: OauthHost = {
      claudeHome: host.claudeHome,
      platform: 'darwin',
      fetch: net.fetch,
      keychain: () => undefined,
    }
    const state = openOauth()
    await expect(pollOauth(bare, state, journal, { enabled: true })).resolves.toBeNull()
    expect(net.calls).toBe(0)
    expect(state.problem).toBe('токен Claude Code не найден')
  })
})

describe('удачный ответ', () => {
  it('ложится в журнал и показывается в настройках', async () => {
    const { fetch, calls } = replying(200, live)
    const state = openOauth()
    const snapshot = await pollOauth(withToken(fetch), state, journal, {
      enabled: true,
      now: 1000,
    })

    expect(snapshot?.source).toBe('oauth')
    expect(snapshot?.weekly?.pct).toBe(19)
    expect(journal.snapshots).toHaveLength(1)
    expect(readFileSync(journal.path, 'utf8')).toContain('"source":"oauth"')

    const status = oauthStatus(withToken(fetch), state, true)
    expect(status).toMatchObject({ enabled: true, weeklyPct: 19, fetchedAt: 1000 })

    // Токен уходит только в заголовок запроса и никуда больше.
    expect(calls[0]?.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(JSON.stringify(status)).not.toContain('sk-ant')
  })

  it('второй раз в течение четверти часа в сеть не идёт', async () => {
    const first = replying(200, live)
    const state = openOauth()
    await pollOauth(withToken(first.fetch), state, journal, { enabled: true, now: 1000 })
    await pollOauth(withToken(first.fetch), state, journal, { enabled: true, now: 1000 + 899_000 })
    expect(first.calls).toHaveLength(1)
  })

  it('кнопка снимает кэш', async () => {
    const { fetch, calls } = replying(200, live)
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 2000, force: true })
    expect(calls).toHaveLength(2)
  })

  it('тот же ответ второй раз журнал не растит', async () => {
    const { fetch } = replying(200, live)
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })
    const again = await pollOauth(withToken(fetch), state, journal, {
      enabled: true,
      now: 2000,
      force: true,
    })
    expect(again).toBeNull()
    expect(journal.snapshots).toHaveLength(1)
  })
})

describe('отказы', () => {
  it('429 закрывает окно на срок из Retry-After', async () => {
    const { fetch, calls } = replying(429, {}, { 'retry-after': '60' })
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })
    expect(state.throttle?.retryAt).toBe(61_000)

    // Внутри окна не ходим даже по кнопке: кнопка не должна уметь ломать
    // чужой запрет. Проверяется счётчиком запросов, а не результатом: `null`
    // вернулся бы и после настоящего похода в сеть.
    await expect(
      pollOauth(withToken(fetch), state, journal, { enabled: true, now: 2000, force: true }),
    ).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('Retry-After: 0 не значит «можно сразу»', async () => {
    const { fetch } = replying(429, {}, { 'retry-after': '0' })
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })
    expect(state.throttle?.retryAt).toBe(1000 + 5 * 60_000)
  })

  it('401 не повторяется сам — только кнопкой', async () => {
    const { fetch, calls } = replying(401, {})
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })
    expect(state.needsLogin).toBe(true)

    // Тем же `fetch`, а не запрещающим: проверяется, что запроса не было, —
    // счётчик вызовов, а не отсутствие исключения.
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 10_000_000 })
    expect(calls).toHaveLength(1)

    await pollOauth(withToken(fetch), state, journal, {
      enabled: true,
      now: 10_000_000,
      force: true,
    })
    expect(calls).toHaveLength(2)
  })

  it('обрыв связи не стирает прежний снимок с экрана', async () => {
    const { fetch } = replying(200, live)
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })

    const broken = (() => Promise.reject(new Error('нет сети'))) as typeof globalThis.fetch
    await pollOauth(withToken(broken), state, journal, { enabled: true, now: 2000, force: true })

    const status = oauthStatus(withToken(fetch), state, true)
    expect(status.weeklyPct).toBe(19)
    expect(status.fetchedAt).toBe(1000)
    expect(status.problem).toBe('не дозвонились до Anthropic — показан прежний ответ')
  })

  it('тело ответа наружу не показывается — только наш пересказ', async () => {
    const { fetch } = replying(500, { error: { message: 'Bearer sk-ant-oat01-секрет' } })
    const state = openOauth()
    await pollOauth(withToken(fetch), state, journal, { enabled: true, now: 1000 })
    expect(state.problem).toBe('Anthropic ответил 500')
  })
})
