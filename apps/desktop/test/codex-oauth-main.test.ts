import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@agentmeter/core'
import {
  codexOauthStatus,
  openCodexOauth,
  pollCodexOauth,
  readCodexToken,
  type CodexOauthHost,
} from '../src/main/codex-oauth.ts'

/**
 * Второй источник лимитов Codex в main (6.4): токен, запрос, кэш.
 *
 * Проверки названы поломкой, которую ловят, и первая из них та же, что у
 * соседа: при выключенной настройке запроса не уходит вовсе. Держится она на
 * **счётчике вызовов**, а не на падающем `fetch`, и это разница по существу —
 * `pollCodexOauth` ловит ошибку сети сам, так что брошенное исключение он
 * честно превратит в «не дозвонились», и тест на нём пережил бы удаление
 * проверки настройки. В 6.3 этот тест был фиктивным ровно так.
 */

let dir: string
let host: (fetch: CodexOauthHost['fetch']) => CodexOauthHost

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/usage/codex-oauth.json', import.meta.url), 'utf8'),
) as {
  ts: number
  cases: { name: string; response: unknown }[]
  credentials: { name: string; raw: unknown }[]
}

const at = fixture.ts
const body = (name: string): unknown => fixture.cases.find((entry) => entry.name === name)!.response
const auth = (name: string): unknown =>
  fixture.credentials.find((entry) => entry.name === name)!.raw

/** `fetch`, который считает вызовы и падает: проверка «в сеть не ходили». */
function forbidden(): { fetch: CodexOauthHost['fetch']; calls: number } {
  const box = {
    calls: 0,
    fetch: (() => {
      box.calls += 1
      throw new Error('в сеть ходить не должны были')
    }) as CodexOauthHost['fetch'],
  }
  return box
}

function replying(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): { fetch: CodexOauthHost['fetch']; calls: Array<{ url: string; headers: Headers }> } {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    )
  }) as CodexOauthHost['fetch']
  return { fetch, calls }
}

function writeAuth(name: string): void {
  writeFileSync(join(dir, 'codex', 'auth.json'), JSON.stringify(auth(name)))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-codex-oauth-'))
  setLocale('ru')
  mkdirSync(join(dir, 'codex'), { recursive: true })
  host = (fetch) => ({ codexHome: join(dir, 'codex'), fetch })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('токен', () => {
  it('читается из auth.json вместе с идентификатором аккаунта', () => {
    writeAuth('oauth')
    const read = readCodexToken(host(forbidden().fetch), at)
    expect(read.from).toBe('file')
    expect(read.credentials?.accountId).toBe('a3bf69ee-ed01-4ca0-a8ae-70560c648034')
  })

  /**
   * Ловит слияние «просрочен» с «не найден». Советы разные: первый лечится
   * запуском `codex`, второй — входом в него.
   */
  it('просроченный токен отличается от ненайденного', () => {
    writeAuth('expired')
    expect(readCodexToken(host(forbidden().fetch), at).from).toBe('expired')
    rmSync(join(dir, 'codex', 'auth.json'))
    expect(readCodexToken(host(forbidden().fetch), at).from).toBe('missing')
  })

  it('вход по ключу API токеном не считается', () => {
    writeAuth('api-key-only')
    expect(readCodexToken(host(forbidden().fetch), at).from).toBe('missing')
  })
})

describe('запрос', () => {
  /** Главная проверка этапа: выключенная настройка снимает вызов целиком. */
  it('при выключенной настройке в сеть не ходим вовсе', async () => {
    writeAuth('oauth')
    const net = forbidden()
    const state = openCodexOauth()
    expect(await pollCodexOauth(host(net.fetch), state, { enabled: false, force: true })).toBeNull()
    expect(net.calls).toBe(0)
  })

  /** И то же самое с мёртвым токеном: 401 мы и так получим, ходить незачем. */
  it('с просроченным токеном в сеть не ходим', async () => {
    writeAuth('expired')
    const net = forbidden()
    const state = openCodexOauth()
    expect(await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at })).toBeNull()
    expect(net.calls).toBe(0)
    expect(state.problem).toContain('просрочен')
  })

  it('удачный ответ разбирается в окна и запоминается', async () => {
    writeAuth('oauth')
    const net = replying(200, body('slots-swapped'))
    const state = openCodexOauth()
    const windows = await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at })

    expect(windows?.map((window) => window.kind).sort()).toEqual(['fiveHour', 'weekly'])
    expect(state.fetchedAt).toBe(at)
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0]!.url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(net.calls[0]!.headers.get('chatgpt-account-id')).toBe(
      'a3bf69ee-ed01-4ca0-a8ae-70560c648034',
    )
  })

  /**
   * Ловит утечку токена в заголовке не туда и подмену `User-Agent`: врать
   * провайдеру о том, кто стучится, в продукте про честность цифр нельзя.
   */
  it('в запрос уходит наше имя, а токен — только в authorization', async () => {
    writeAuth('oauth')
    const net = replying(200, body('live'))
    await pollCodexOauth(host(net.fetch), openCodexOauth(), { enabled: true, now: at })
    const headers = net.calls[0]!.headers
    expect(headers.get('user-agent')).toBe('Agentmeter')
    expect(headers.get('authorization')).toContain('Bearer ')
  })

  it('свежий кэш второго запроса не делает, а кнопка делает', async () => {
    writeAuth('oauth')
    const net = replying(200, body('live'))
    const state = openCodexOauth()
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at })
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at + 60_000 })
    expect(net.calls).toHaveLength(1)
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at + 60_000, force: true })
    expect(net.calls).toHaveLength(2)
  })

  it('401 гасит автоматические попытки, но не кнопку', async () => {
    writeAuth('oauth')
    const net = replying(401, {})
    const state = openCodexOauth()
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at })
    expect(state.needsLogin).toBe(true)

    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at + 3_600_000 })
    expect(net.calls).toHaveLength(1)
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at + 3_600_000, force: true })
    expect(net.calls).toHaveLength(2)
  })

  /** Ловит `force`, ломающий чужой запрет: 429 кнопкой не снимается. */
  it('429 замолкает на своё окно, и кнопка его не снимает', async () => {
    writeAuth('oauth')
    const net = replying(429, {}, { 'retry-after': '120' })
    const state = openCodexOauth()
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at })
    expect(state.throttle?.retryAt).toBe(at + 120_000)

    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at + 60_000, force: true })
    expect(net.calls).toHaveLength(1)
    await pollCodexOauth(host(net.fetch), state, { enabled: true, now: at + 121_000 })
    expect(net.calls).toHaveLength(2)
  })

  /**
   * Ловит стирание прежнего ответа отказом сети. «Не дозвонились» — не то же
   * самое, что «лимит неизвестен», и прежние окна обязаны остаться на экране.
   */
  it('обрыв связи оставляет прежние окна', async () => {
    writeAuth('oauth')
    const state = openCodexOauth()
    await pollCodexOauth(host(replying(200, body('live')).fetch), state, { enabled: true, now: at })
    const before = state.windows

    await pollCodexOauth(host(forbidden().fetch), state, {
      enabled: true,
      now: at + 3_600_000,
      force: true,
    })
    expect(state.windows).toBe(before)
    expect(state.problem).toContain('не дозвонились')
  })

  /** Пустой ответ — тоже ответ: возраст обновился, прежние окна остались. */
  it('ответ без окон не стирает прежние, но обновляет возраст', async () => {
    writeAuth('oauth')
    const state = openCodexOauth()
    await pollCodexOauth(host(replying(200, body('live')).fetch), state, { enabled: true, now: at })

    const fresh = await pollCodexOauth(host(replying(200, body('empty')).fetch), state, {
      enabled: true,
      now: at + 3_600_000,
      force: true,
    })
    expect(fresh).toBeNull()
    expect(state.windows).toHaveLength(1)
    expect(state.fetchedAt).toBe(at + 3_600_000)
  })

  /** Ловит показ чужого тела наружу: экран настроек видят через плечо. */
  it('чужой отказ пересказывается своими словами', async () => {
    writeAuth('oauth')
    const state = openCodexOauth()
    await pollCodexOauth(host(replying(500, { error: 'секрет из тела' }).fetch), state, {
      enabled: true,
      now: at,
    })
    expect(state.problem).toBe('OpenAI ответил 500')
  })
})

describe('строка настроек', () => {
  /**
   * Ловит чтение чужого файла при выключенной настройке. Токен читается только
   * с разрешения — иначе тумблер «не спрашивать» ничего бы не значил.
   */
  it('выключенный источник не читает токен', () => {
    writeAuth('oauth')
    const status = codexOauthStatus(host(forbidden().fetch), openCodexOauth(), false, at)
    expect(status.credentials).toBe('missing')
    expect(status.enabled).toBe(false)
  })

  it('включённый показывает окна последнего ответа', async () => {
    writeAuth('oauth')
    const state = openCodexOauth()
    await pollCodexOauth(host(replying(200, body('slots-swapped')).fetch), state, {
      enabled: true,
      now: at,
    })
    const status = codexOauthStatus(host(forbidden().fetch), state, true, at)
    expect(status.windows).toEqual([
      { kind: 'weekly', windowMinutes: 10_080, pct: 43 },
      { kind: 'fiveHour', windowMinutes: 300, pct: 12 },
    ])
    expect(status.fetchedAt).toBe(at)
  })
})
