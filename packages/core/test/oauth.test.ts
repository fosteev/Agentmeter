/**
 * Второй источник настоящих лимитов: разбор `/api/oauth/usage` (6.3).
 *
 * Эталоны здесь двух сортов. Ответы (`fixtures/oauth/`) сняты живыми — по ним
 * проверяется, что мы понимаем чужой формат, включая поля, смысла которых не
 * знаем. Целочисленный журнал (`fixtures/usage/journal-oauth.jsonl`) посчитан
 * руками под известный ответ — по нему проверяется порог `minIntegerPct`, и
 * допусков «примерно» там нет: система линейна и точна.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CALIBRATION,
  DEFAULT_RETRY_MS,
  calibrate,
  parseCredentials,
  parseOauthUsage,
  parseRetryAfter,
  readUsageJournal,
  throttleFrom,
  throttled,
  type LimitRequest,
} from '../src/index.ts'

const oauthDir = fileURLToPath(new URL('../../../fixtures/oauth/', import.meta.url))
const usageDir = fileURLToPath(new URL('../../../fixtures/usage/', import.meta.url))
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

const live = read(`${oauthDir}usage-live.json`)
const models = read(`${oauthDir}usage-models.json`)

describe('разбор ответа', () => {
  it('живой ответ разбирается в два окна', () => {
    const snapshot = parseOauthUsage(live, 1000)
    expect(snapshot).toEqual({
      ts: 1000,
      sessionId: '',
      source: 'oauth',
      // Ноль — не «расхода нет», а «окно сброшено 15 минутами раньше»:
      // `resets_at` стоит на 00:40 следующих суток.
      fiveHour: { pct: 0, resetsAt: Date.parse('2026-08-12T00:40:00.668848+00:00') },
      weekly: { pct: 19, resetsAt: Date.parse('2026-08-16T05:00:00.668875+00:00') },
    })
  })

  it('проценты приезжают целыми — на этом стоит порог калибровки', () => {
    const snapshot = parseOauthUsage(live, 1)!
    expect(Number.isInteger(snapshot.weekly!.pct)).toBe(true)
  })

  it('модельные окна пропускаются, а не роняют ответ', () => {
    const snapshot = parseOauthUsage(models, 1000)!
    // В фикстуре кроме `session` и `weekly_all` лежат `weekly_scoped` на Opus
    // (73%, активное) и на Fable (без `resets_at`). Ни одно не должно подменить
    // собой недельное окно: 41 — это `weekly_all`.
    expect(snapshot.fiveHour?.pct).toBe(64)
    expect(snapshot.weekly?.pct).toBe(41)
    expect(Object.keys(snapshot).sort()).toEqual(['fiveHour', 'sessionId', 'source', 'ts', 'weekly'])
  })

  it('окно без границы не берётся: калибровать по нему нечего', () => {
    const body = { limits: [{ kind: 'session', percent: 40, resets_at: null }] }
    expect(parseOauthUsage(body, 1)).toBeNull()
  })

  it('процент вне 0…100 роняет запись, а не весь ответ', () => {
    const body = {
      limits: [
        { kind: 'session', percent: 140, resets_at: '2026-08-12T00:40:00Z' },
        { kind: 'weekly_all', percent: 19, resets_at: '2026-08-16T05:00:00Z' },
      ],
    }
    const snapshot = parseOauthUsage(body, 1)!
    expect(snapshot.fiveHour).toBeUndefined()
    expect(snapshot.weekly?.pct).toBe(19)
  })

  it('незнакомый вид окна пропускается молча', () => {
    const body = {
      limits: [
        { kind: 'nimbus_quill', percent: 7, resets_at: '2026-08-12T00:40:00Z' },
        { kind: 'session', percent: 12, resets_at: '2026-08-12T00:40:00Z' },
      ],
    }
    expect(parseOauthUsage(body, 1)?.fiveHour?.pct).toBe(12)
  })

  it('не тот формат — не снимок', () => {
    expect(parseOauthUsage({ five_hour: { utilization: 19 } }, 1)).toBeNull()
    expect(parseOauthUsage('не объект', 1)).toBeNull()
    expect(parseOauthUsage({ limits: [] }, 1)).toBeNull()
  })
})

describe('Retry-After', () => {
  const now = Date.parse('2026-08-11T20:00:00Z')

  it('секунды', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000)
  })

  it('HTTP-дата', () => {
    expect(parseRetryAfter('Tue, 11 Aug 2026 20:05:00 GMT', now)).toBe(300_000)
  })

  it('ноль отбраковывается: эндпоинт отдаёт его, продолжая отказывать', () => {
    expect(parseRetryAfter('0', now)).toBeUndefined()
    expect(throttleFrom('0', now).retryAt).toBe(now + DEFAULT_RETRY_MS)
  })

  it('прошедшая дата и мусор — то же самое, что отсутствие заголовка', () => {
    expect(parseRetryAfter('Tue, 11 Aug 2026 19:00:00 GMT', now)).toBeUndefined()
    expect(parseRetryAfter('когда-нибудь', now)).toBeUndefined()
    expect(parseRetryAfter('', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
    expect(throttleFrom(null, now).retryAt).toBe(now + DEFAULT_RETRY_MS)
  })

  it('окно истекает', () => {
    const throttle = throttleFrom('60', now)
    expect(throttled(throttle, now + 59_000)).toBe(true)
    expect(throttled(throttle, now + 61_000)).toBe(false)
    expect(throttled(undefined, now)).toBe(false)
  })
})

describe('креденшелы', () => {
  it('токен достаётся из формы Keychain', () => {
    const raw = readFileSync(`${oauthDir}credentials-keychain.json`, 'utf8')
    expect(parseCredentials(raw)).toMatch(/^sk-ant-oat01-FIXTURE/)
  })

  it('без токена — undefined, а не пустая строка', () => {
    expect(parseCredentials('{}')).toBeUndefined()
    expect(parseCredentials('{"claudeAiOauth":{}}')).toBeUndefined()
    expect(parseCredentials('{"claudeAiOauth":{"accessToken":""}}')).toBeUndefined()
    expect(parseCredentials('не json')).toBeUndefined()
  })
})

describe('порог целочисленного источника', () => {
  const requests = (read(`${usageDir}requests-oauth.json`) as { requests: LimitRequest[] }).requests
  const journal = readUsageJournal(`${usageDir}journal-oauth.jsonl`)
  const expected = read(`${usageDir}expected-oauth.json`) as {
    withThreshold: { points: number; cap: number; weight: number; capSpread: number }
    withoutThreshold: { points: number; cap: number; capSpread: number; extraBlocker: string }
  }

  it('точка ниже порога отсеяна, решение точное', () => {
    const fit = calibrate(journal, requests).fiveHour
    expect(fit.points).toBe(expected.withThreshold.points)
    expect(fit.cap).toBeCloseTo(expected.withThreshold.cap, 6)
    expect(fit.weight).toBeCloseTo(expected.withThreshold.weight, 9)
    expect(fit.capSpread).toBe(expected.withThreshold.capSpread)
  })

  it('без порога одна точка с квантованием ломает калибровку целиком', () => {
    // Порог обходится подменой источника: те же проценты, помеченные как
    // дробные, идут в систему все. Так проверяется именно порог, а не то, что
    // в фикстуре четыре строки.
    const asStatusline = journal.map((snapshot) => ({ ...snapshot, source: 'statusline' as const }))
    const fit = calibrate(asStatusline, requests).fiveHour
    expect(fit.points).toBe(expected.withoutThreshold.points)
    expect(fit.cap).toBeCloseTo(expected.withoutThreshold.cap, 6)
    expect(fit.capSpread).toBeCloseTo(expected.withoutThreshold.capSpread, 9)
    expect(calibrate(asStatusline, requests).blockers).toContain(
      expected.withoutThreshold.extraBlocker,
    )
  })

  it('порог не трогает дробные снимки', () => {
    // Тот же малый процент, но дробный: 5.4 из строки состояния — настоящее
    // наблюдение, и отсеивать его не за что.
    const ts = Date.parse('2026-05-04T16:20:00Z')
    const resetsAt = Date.parse('2026-05-04T21:00:00Z')
    const fractional = [
      { ts, sessionId: 'a', fiveHour: { pct: 5.4, resetsAt } },
      { ts: ts + 1, sessionId: 'a', source: 'oauth' as const, fiveHour: { pct: 5, resetsAt } },
    ]
    const points = calibrate(fractional, requests).fiveHour.points
    expect(points).toBe(1)
    expect(CALIBRATION.minIntegerPct).toBe(10)
  })
})
