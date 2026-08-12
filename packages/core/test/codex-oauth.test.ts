/**
 * Второй источник лимитов Codex: разбор `wham/usage` (6.4).
 *
 * Все случаи приходят из `fixtures/usage/codex-oauth.json`, и каждый написан
 * под одно правило — правило названо в его `_`. Первый снят живым 12 августа,
 * остальные собраны руками: живой ответ сам по себе не различает ошибок,
 * которые здесь ловятся, потому что в нём одно окно и один слот.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  codexTokenExpired,
  parseCodexCredentials,
  parseCodexUsage,
  type LimitWindow,
} from '../src/index.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/usage/codex-oauth.json', import.meta.url)), 'utf8'),
) as {
  ts: number
  cases: { name: string; response: unknown; windows: LimitWindow[] }[]
  credentials: {
    name: string
    raw: unknown
    rawText?: string
    parsed: { token: string; accountId?: string; expiresAt?: number } | null
    expired: boolean
  }[]
}

const at = fixture.ts
const one = (name: string): (typeof fixture.cases)[number] => {
  const found = fixture.cases.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`случая ${name} в эталоне нет`)
  return found
}

describe('разбор ответа', () => {
  // Каждый случай эталона проверяется целиком — `toEqual`, а не «есть такое
  // поле»: лишнее окно в ответе так же неверно, как недостающее.
  for (const entry of fixture.cases) {
    it(`${entry.name}: ответ разбирается ровно в свои окна`, () => {
      expect(parseCodexUsage(entry.response, at)).toEqual(entry.windows)
    })
  }

  /**
   * Отдельной проверкой поверх переборной: та упадёт и от опечатки в числе, а
   * эта называет поломку, ради которой эталон и написан.
   *
   * Разбор по имени слота — то, что делает ClaudeBar (`primary` → session,
   * `secondary` → weekly) и что ломается на живом Codex: с CLI 0.145.0
   * недельное окно приезжает **в `primary`**. Здесь слоты переставлены, и
   * разбор по именам дал бы те же два окна с переставленными видами.
   */
  it('вид окна — из его длины, а не из имени слота', () => {
    const windows = parseCodexUsage(one('slots-swapped').response, at)
    const byKind = new Map(windows.map((window) => [window.kind, window]))
    expect(byKind.get('weekly')?.usedPercent).toBe(43)
    expect(byKind.get('weekly')?.windowMinutes).toBe(10_080)
    expect(byKind.get('fiveHour')?.usedPercent).toBe(12)
    expect(byKind.get('fiveHour')?.windowMinutes).toBe(300)
  })

  /** Живой ответ: недельное окно в `primary`, `secondary` пуст — и это норма. */
  it('живой ответ даёт одно недельное окно из слота primary', () => {
    const windows = parseCodexUsage(one('live').response, at)
    expect(windows).toHaveLength(1)
    expect(windows[0]!.kind).toBe('weekly')
  })

  /**
   * Ловит подстановку «раз это primary, значит пять часов». Без длины окно не
   * имеет ни вида, ни начала, и выбросить его — единственный честный ответ.
   */
  it('окно без длины выпадает, а соседнее остаётся', () => {
    const windows = parseCodexUsage(one('length-missing').response, at)
    expect(windows.map((window) => window.usedPercent)).toEqual([55])
  })

  /** Ловит округление процента до целого: у Codex он дробный, в отличие от Anthropic. */
  it('дробный процент доезжает дробным', () => {
    expect(parseCodexUsage(one('reset-after').response, at)[0]!.usedPercent).toBe(33.5)
  })

  /**
   * Ловит разбор соседних пулов. `code_review_rate_limit` и
   * `additional_rate_limits` — другие потолки, и в списке окон они станут
   * вторым недельным окном Codex, неотличимым от настоящего.
   */
  it('соседние пулы лимитов не попадают в окна', () => {
    const windows = parseCodexUsage(one('other-pools').response, at)
    expect(windows).toHaveLength(1)
    expect(windows[0]!.usedPercent).toBe(7)
  })

  it('процент вне 0…100 роняет своё окно, а не ответ', () => {
    const windows = parseCodexUsage(one('junk').response, at)
    expect(windows.map((window) => window.usedPercent)).toEqual([7])
  })

  it('мусор на входе даёт пустой список, а не исключение', () => {
    expect(parseCodexUsage(null, at)).toEqual([])
    expect(parseCodexUsage('строка', at)).toEqual([])
    expect(parseCodexUsage({ rate_limit: [] }, at)).toEqual([])
  })
})

describe('креденшелы', () => {
  for (const entry of fixture.credentials) {
    it(`${entry.name}: файл разбирается как задумано`, () => {
      const raw = entry.rawText ?? JSON.stringify(entry.raw)
      const parsed = parseCodexCredentials(raw)
      if (entry.parsed === null) {
        expect(parsed).toBeUndefined()
        return
      }
      expect(parsed).toEqual(entry.parsed)
      expect(codexTokenExpired(parsed!, at)).toBe(entry.expired)
    })
  }

  /**
   * Ловит «не прочитали срок — значит просрочен». Такое правило выключило бы
   * источник у всех, чей токен не JWT, и выключило бы молча.
   */
  it('нечитаемый срок — не просроченный', () => {
    const parsed = parseCodexCredentials(JSON.stringify({ tokens: { access_token: 'opaque' } }))!
    expect(parsed.expiresAt).toBeUndefined()
    expect(codexTokenExpired(parsed, at)).toBe(false)
  })

  /**
   * Ловит чтение `refresh_token` наружу. Его тут нет намеренно: обмен
   * одноразового токена обесценил бы тот, что лежит у Codex CLI, и разлогинил
   * бы человека из самого Codex.
   */
  it('refresh-токен не читается вовсе', () => {
    const parsed = parseCodexCredentials(
      JSON.stringify({ tokens: { access_token: 'a.b.c', refresh_token: 'rt.secret' } }),
    )!
    expect(JSON.stringify(parsed)).not.toContain('rt.secret')
  })
})
