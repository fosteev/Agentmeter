/**
 * Журнал statusLine и калибровка веса `cache_read` (1.9).
 *
 * Эталон рукописный и обратный: сначала выбраны вес и потолки, потом под них
 * посчитаны проценты (`fixtures/usage/README.md`). Поэтому здесь нет допусков
 * «примерно»: система линейна и точна, и МНК обязан вернуть ровно зашитые
 * числа. Допуск в такой проверке — это разрешение подогнать коэффициент.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CALIBRATION,
  appendUsageJournal,
  calibrate,
  parseStatusLine,
  readUsageJournal,
  usageKeys,
  type LimitRequest,
  type UsageSnapshot,
} from '../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../../fixtures/usage/', import.meta.url))

interface ExpectedFit {
  points: number
  windows: number
  cap: number
  weight: number
  residualPp: number
  capSpread: number
  shareSpread: number
}

interface Expected {
  truth: { cacheReadWeight: number; fiveHourCap: number; weeklyCap: number }
  fiveHour: ExpectedFit
  weekly: ExpectedFit
  dropped: { kind: string; resetsAt: number; reason: string; points: number }[]
  weightGap: number
  verdict: {
    ok: boolean
    blockers: string[]
    cacheReadWeight: number | null
    fiveHourCap: number | null
    weeklyCap: number | null
  }
}

interface StatusLineFixture {
  samples: { stdin: unknown; snapshot: UsageSnapshot | null }[]
}

const expected: Expected = JSON.parse(readFileSync(join(fixturesDir, 'expected.json'), 'utf8'))
const requests: LimitRequest[] = (
  JSON.parse(readFileSync(join(fixturesDir, 'requests.json'), 'utf8')) as {
    requests: (LimitRequest & { at: string })[]
  }
).requests.map(({ ts, input, output, cacheWrite, cacheRead }) => ({
  ts,
  input,
  output,
  cacheWrite,
  cacheRead,
}))
const journal = readUsageJournal(join(fixturesDir, 'journal.jsonl'))

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentmeter-usage-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

describe('снимок statusLine', () => {
  const fixture: StatusLineFixture = JSON.parse(
    readFileSync(join(fixturesDir, 'statusline.json'), 'utf8'),
  )

  it('разбирается ровно так, как записан в эталоне', () => {
    for (const sample of fixture.samples) {
      const ts = sample.snapshot?.ts ?? 1777630200000
      expect(parseStatusLine(sample.stdin, ts)).toEqual(sample.snapshot)
    }
  })

  it('переводит resets_at из секунд в миллисекунды', () => {
    const parsed = parseStatusLine(fixture.samples[0]!.stdin, 1)
    // Секунды, доехавшие до журнала как есть, дали бы окно, кончившееся в
    // январе 1970-го, — и калибровка молча осталась бы без единой точки.
    expect(parsed?.fiveHour?.resetsAt).toBe(1777647600 * 1000)
    expect(parsed?.weekly?.resetsAt).toBe(1777939200 * 1000)
  })

  it('без rate_limits записывать нечего', () => {
    expect(parseStatusLine({ session_id: 'a', version: '2.1.85' }, 1)).toBeNull()
    expect(parseStatusLine('не объект', 1)).toBeNull()
    expect(parseStatusLine({ rate_limits: {} }, 1)).toBeNull()
  })

  it('дробный процент не округляется', () => {
    const parsed = parseStatusLine(
      { rate_limits: { seven_day: { used_percentage: 14.000000000000002, resets_at: 100 } } },
      1,
    )
    expect(parsed?.weekly?.pct).toBe(14.000000000000002)
  })
})

describe('журнал', () => {
  it('дозаписывается и читается обратно тем же', () => {
    const path = join(tempDir(), 'usage.jsonl')
    appendUsageJournal(path, journal.slice(0, 2))
    appendUsageJournal(path, journal.slice(2))
    expect(readUsageJournal(path)).toEqual(journal)
  })

  it('оборванная строка стоит одного наблюдения, а не всего файла', () => {
    const path = join(tempDir(), 'usage.jsonl')
    appendUsageJournal(path, journal)
    writeFileSync(path, readFileSync(path, 'utf8') + '{"ts":1777674600000,"five', 'utf8')
    expect(readUsageJournal(path)).toHaveLength(journal.length)
  })

  it('ключ дедупа — пара (процент, момент сброса) каждого окна', () => {
    expect(usageKeys(journal[0]!)).toEqual([
      'fiveHour:17.5:1777647600000',
      'weekly:0.875:1777939200000',
    ])
    // Недельное окно повторяется часами. Схлопни дедуп запись целиком по нему —
    // и пятичасовые точки, ради которых всё затевалось, перестали бы копиться.
    const keys = new Set(usageKeys(journal[0]!))
    expect(usageKeys(journal[1]!).some((key) => !keys.has(key))).toBe(true)
  })

  it('на пустом месте отдаёт пустоту, а не падает', () => {
    expect(readUsageJournal(join(tempDir(), 'нет-такого.jsonl'))).toEqual([])
  })
})

describe('калибровка по эталону', () => {
  const result = calibrate(journal, requests)

  it('пятичасовые окна дают зашитые вес и потолок', () => {
    expect(result.fiveHour.weight).toBeCloseTo(expected.fiveHour.weight, 12)
    expect(result.fiveHour.cap).toBeCloseTo(expected.fiveHour.cap, 6)
    expect(result.fiveHour.points).toBe(expected.fiveHour.points)
    expect(result.fiveHour.windows).toBe(expected.fiveHour.windows)
    expect(result.fiveHour.residualPp).toBeCloseTo(expected.fiveHour.residualPp, 9)
    expect(result.fiveHour.capSpread).toBeCloseTo(expected.fiveHour.capSpread, 9)
    expect(result.fiveHour.shareSpread).toBeCloseTo(expected.fiveHour.shareSpread, 12)
    expect(result.fiveHour.reason).toBeUndefined()
  })

  it('недельное окно даёт свой потолок и тот же вес', () => {
    expect(result.weekly.weight).toBeCloseTo(expected.weekly.weight, 12)
    expect(result.weekly.cap).toBeCloseTo(expected.weekly.cap, 5)
    expect(result.weekly.points).toBe(expected.weekly.points)
    expect(result.weekly.windows).toBe(expected.weekly.windows)
    expect(result.weightGap).toBeCloseTo(expected.weightGap, 12)
  })

  it('окно с чужим расходом выброшено, а не усреднено', () => {
    expect(result.dropped).toEqual(expected.dropped.map(({ _, ...rest }: never) => rest))
  })

  it('заражение действует вперёд: недельное окно обрезано, а не потеряно', () => {
    // Пять точек до чужого расхода целы, шестая отброшена. Выброси окно
    // целиком — и недельного уравнения не осталось бы вовсе, а с ним и
    // единственной проверки модели: вес обязан совпасть с пятичасовым.
    expect(result.weekly.points).toBe(5)
    expect(result.weekly.weight).not.toBeNull()
  })

  it('данных мало — вес наружу не уходит', () => {
    expect(result.ok).toBe(expected.verdict.ok)
    expect(result.blockers).toEqual(expected.verdict.blockers)
    expect(result.cacheReadWeight).toBeNull()
    expect(result.fiveHourCap).toBeNull()
    expect(result.weeklyCap).toBeNull()
  })
})

describe('калибровка отказывается там, где обязана', () => {
  const WEEKLY_RESETS = Date.UTC(2026, 4, 8)
  const WEEKLY_CAP = 4_000_000

  /**
   * Тот же эталонный ответ, но точек столько, сколько требует критерий.
   *
   * Недельное окно считается тем же весом и своим потолком: без него
   * калибровка честно упирается в `no-fit` — сверять вес не с чем, а сверка
   * между окнами и есть проверка модели.
   */
  function synthetic(windows: number, weight = 0.15, cap = 200_000, weeklyWeight = weight) {
    const snapshots: UsageSnapshot[] = []
    const made: LimitRequest[] = []
    let weekPlain = 0
    let weekRead = 0
    for (let index = 0; index < windows; index += 1) {
      const startsAt = Date.UTC(2026, 4, 1) + index * 6 * 3_600_000
      const resetsAt = startsAt + 5 * 3_600_000
      let plain = 0
      let cacheRead = 0
      for (let step = 0; step < 8; step += 1) {
        // Доля чтения кэша гуляет от шага к шагу — иначе вес и потолок
        // неразделимы, и это ровно то, что проверяет `flat-share`.
        const request: LimitRequest = {
          ts: startsAt + step * 600_000,
          input: 1_000 + step * 100,
          output: 1_000,
          cacheWrite: 2_000,
          cacheRead: step % 2 === 0 ? 40_000 : 4_000,
        }
        made.push(request)
        plain += request.input + request.output + request.cacheWrite
        cacheRead += request.cacheRead
        weekPlain += request.input + request.output + request.cacheWrite
        weekRead += request.cacheRead
        snapshots.push({
          ts: request.ts + 60_000,
          sessionId: `s${index}`,
          fiveHour: { pct: ((plain + weight * cacheRead) * 100) / cap, resetsAt },
          weekly: {
            pct: ((weekPlain + weeklyWeight * weekRead) * 100) / WEEKLY_CAP,
            resetsAt: WEEKLY_RESETS,
          },
        })
      }
    }
    return { snapshots, requests: made }
  }

  it('на полной выборке вес доезжает до конфига', () => {
    const { snapshots, requests: made } = synthetic(3)
    const result = calibrate(snapshots, made)
    expect(result.fiveHour.points).toBeGreaterThanOrEqual(CALIBRATION.minPoints)
    expect(result.fiveHour.windows).toBeGreaterThanOrEqual(CALIBRATION.minWindows)
    expect(result.blockers).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.cacheReadWeight).toBeCloseTo(0.15, 9)
    expect(result.fiveHourCap).toBeCloseTo(200_000, 3)
    // Вес обязан совпасть между окнами разной длины — это и есть проверка
    // модели, а не пересчёт: потолки у них разные, а коэффициент один.
    expect(result.weeklyCap).toBeCloseTo(4_000_000, 2)
    expect(result.weightGap).toBeLessThan(CALIBRATION.maxWeightGap)
  })

  it('вес, не совпавший между окнами, наружу не уходит', () => {
    // Недельное окно считает чтение кэша вдвое дороже. Каждое решение по
    // отдельности осмысленно, вместе — сообщение о том, что модель не та.
    // Множитель на процент здесь не годится: он меняет потолок, а не вес.
    const { snapshots: broken, requests: made } = synthetic(3, 0.15, 200_000, 0.3)
    const result = calibrate(broken, made)
    expect(result.fiveHour.weight).toBeCloseTo(0.15, 9)
    expect(result.weightGap).toBeGreaterThan(CALIBRATION.maxWeightGap)
    expect(result.blockers).toContain('weight-disagrees')
    expect(result.cacheReadWeight).toBeNull()
  })

  it('одна и та же доля чтения кэша во всех точках — решения нет', () => {
    // Каждый запрос одинакового состава: колонки системы пропорциональны, и
    // решение формально существует, а держится на округлении.
    const requestsFlat: LimitRequest[] = []
    const snapshots: UsageSnapshot[] = []
    const startsAt = Date.UTC(2026, 4, 1)
    const resetsAt = startsAt + 5 * 3_600_000
    let plain = 0
    let cacheRead = 0
    for (let step = 0; step < 8; step += 1) {
      const request: LimitRequest = {
        ts: startsAt + step * 600_000,
        input: 1_000,
        output: 1_000,
        cacheWrite: 2_000,
        cacheRead: 36_000,
      }
      requestsFlat.push(request)
      plain += 4_000
      cacheRead += 36_000
      snapshots.push({
        ts: request.ts + 60_000,
        sessionId: 'flat',
        fiveHour: { pct: ((plain + 0.15 * cacheRead) * 100) / 200_000, resetsAt },
      })
    }
    const result = calibrate(snapshots, requestsFlat)
    expect(result.fiveHour.reason).toBe('flat-share')
    expect(result.fiveHour.weight).toBeNull()
    expect(result.cacheReadWeight).toBeNull()
  })

  it('отставший снимок не завышает потолок', () => {
    // Процент приезжает из ответа API и при параллельных запросах отстаёт
    // (1.8: 57% → 1% и обратно за 13 секунд). Полная наша сумма против
    // заниженного процента — это завышенный потолок, и именно так он и врёт.
    const { snapshots, requests: made } = synthetic(3)
    const clean = calibrate(snapshots, made)
    const stale = [...snapshots]
    const victim = stale[10]!
    stale.splice(11, 0, {
      ts: victim.ts + 1_000,
      sessionId: victim.sessionId,
      fiveHour: { pct: 1, resetsAt: victim.fiveHour!.resetsAt },
    })
    const withStale = calibrate(stale, made)
    expect(withStale.fiveHour.cap).toBeCloseTo(clean.fiveHour.cap!, 3)
    expect(withStale.fiveHour.points).toBe(clean.fiveHour.points)
  })

  it('окно, где процент вырос без наших запросов, выброшено целиком', () => {
    const { snapshots, requests: made } = synthetic(3)
    const resetsAt = snapshots[0]!.fiveHour!.resetsAt
    // Чужая машина съела 30% окна до нашего первого запроса в нём.
    const foreign: UsageSnapshot = {
      ts: snapshots[0]!.ts - 120_000,
      sessionId: 'foreign',
      fiveHour: { pct: 30, resetsAt },
    }
    const result = calibrate([foreign, ...snapshots], made)
    expect(result.dropped).toContainEqual({
      kind: 'fiveHour',
      resetsAt,
      reason: 'foreign',
      points: 9,
    })
    expect(result.fiveHour.windows).toBe(2)
  })

  it('окно, не сошедшееся с остальными по потолку, выброшено как наблюдение о другом', () => {
    const { snapshots, requests: made } = synthetic(4)
    // Четвёртое окно с потолком вдвое ниже: так выглядит расход, часть которого
    // прошла мимо наших логов целиком.
    const odd = synthetic(1, 0.15, 100_000)
    const shifted = odd.snapshots.map((snapshot) => ({
      ...snapshot,
      ts: snapshot.ts + 4 * 6 * 3_600_000,
      fiveHour: {
        pct: snapshot.fiveHour!.pct,
        resetsAt: snapshot.fiveHour!.resetsAt + 4 * 6 * 3_600_000,
      },
    }))
    const shiftedRequests = odd.requests.map((request) => ({
      ...request,
      ts: request.ts + 4 * 6 * 3_600_000,
    }))
    const result = calibrate([...snapshots, ...shifted], [...made, ...shiftedRequests])
    expect(result.dropped.some((window) => window.reason === 'cap-outlier')).toBe(true)
    expect(result.cacheReadWeight).toBeCloseTo(0.15, 6)
  })

  it('вес за пределами доли отвергается, а не подрезается к краю', () => {
    // Вес 1.6 физического смысла не имеет: это сообщение о том, что модель не
    // описывает данные. Подрезка к 1.0 спрятала бы сообщение.
    const { snapshots, requests: made } = synthetic(3, 1.6, 200_000)
    const result = calibrate(snapshots, made)
    expect(result.fiveHour.reason).toBe('out-of-range')
    expect(result.fiveHour.weight).toBeNull()
    expect(result.fiveHour.rejected?.weight).toBeCloseTo(1.6, 6)
    expect(result.cacheReadWeight).toBeNull()
  })

  it('пустой журнал — не ноль, а отсутствие ответа', () => {
    const result = calibrate([], requests)
    expect(result.cacheReadWeight).toBeNull()
    expect(result.fiveHour.reason).toBe('no-points')
    expect(result.blockers).toContain('no-fit')
  })
})
