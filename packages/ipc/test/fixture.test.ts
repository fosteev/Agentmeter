import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TraySnapshot } from '../src/index.ts'
import { IPC_CALLS, IPC_EVENTS } from '../src/index.ts'

/**
 * Фикстура попапа обязана быть ровно тем, что описывает контракт.
 *
 * Тест не про вёрстку — про то, что вход тестов 2.5 не разошёлся с типом. Файл
 * разбирается приведением к `TraySnapshot`, а приведение молчит и о лишних
 * полях, и о недостающих: `as` — не проверка. Здесь проверка.
 */
const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/popup/snapshot.json', import.meta.url)),
    'utf8',
  ),
) as TraySnapshot

describe('fixtures/popup/snapshot.json — контракт 0.4', () => {
  /**
   * Ловит фикстуру, отставшую от контракта: попап собирается по типу, а
   * данные для тестов — по этому файлу, и разойтись они могут молча.
   */
  it('поля снимка ровно те, что в TraySnapshot', () => {
    expect(Object.keys(snapshot).sort()).toEqual(
      ['agents', 'at', 'limits', 'nearestLimitPercent', 'today'].sort(),
    )
    expect(Object.keys(snapshot.today).sort()).toEqual(
      [
        'cacheRead',
        'cacheWrite',
        'input',
        'output',
        'projects',
        'requests',
        'sessions',
        'total',
      ].sort(),
    )
    for (const agent of snapshot.agents) {
      expect(typeof agent.rate).toBe('number')
      expect(typeof agent.approximate).toBe('boolean')
    }
  })

  /**
   * Ловит вход, на котором проверки 2.5 зелены на любом коде. Незнание,
   * оценка и точное число — три разных случая, и если в фикстуре остался
   * только последний, проверять нечего.
   */
  it('несёт все три случая точности и все состояния, ради которых сделана', () => {
    expect(snapshot.limits.some((window) => window.usedPercent === null)).toBe(true)
    expect(snapshot.limits.some((window) => window.exact)).toBe(true)
    expect(snapshot.limits.some((window) => !window.exact && window.usedPercent !== null)).toBe(
      true,
    )
    expect(snapshot.agents.some((agent) => agent.approximate)).toBe(true)
    expect(new Set(snapshot.agents.map((agent) => agent.state))).toEqual(
      new Set(['working', 'waiting', 'done']),
    )
    const done = snapshot.agents.find((agent) => agent.state === 'done')!
    expect(done.endedAt).toBeLessThan(snapshot.at)
  })

  /**
   * Ловит фикстуру, на которой попап нельзя собрать без счёта в окне.
   *
   * `total` в подвале обязан быть суммой четырёх видов, а не «примерно тем же
   * числом»: разойдись он с ними — и тест попапа зафиксирует расхождение как
   * норму. Точность суммы — худшая из четырёх, иначе восстановленное чтение
   * кэша уедет в подвал точным числом.
   */
  it('total в подвале сходится с четырьмя видами и несёт худшую из их точностей', () => {
    const { input, output, cacheWrite, cacheRead, total } = snapshot.today
    expect(total.value).toBe(input.value + output.value + cacheWrite.value + cacheRead.value)
    const ranks = { exact: 0, reconstructed: 1, estimate: 2 } as const
    const worst = [input, output, cacheWrite, cacheRead].reduce((a, b) =>
      ranks[a.confidence] >= ranks[b.confidence] ? a : b,
    )
    expect(total.confidence).toBe(worst.confidence)
    expect(total.caveat).toBe(worst.caveat)
  })

  /**
   * Ловит вход, на котором проверка «незнание не показано нулём» проверяет
   * пустоту: без причины у окна без процента попапу нечего вывести текстом,
   * и любая реализация пройдёт.
   */
  it('у окна без процента есть причина, у окон с процентом её нет', () => {
    for (const window of snapshot.limits) {
      if (window.usedPercent === null) {
        expect(window.unavailableReason).toBeTruthy()
        expect(window.forecast).toBeNull()
      } else {
        expect(window.unavailableReason).toBeNull()
      }
    }
  })

  /**
   * Ловит канал, добавленный строкой мимо контракта: списки — единственный
   * источник имён и для main, и для preload.
   */
  it('списки каналов не пусты и не пересекаются', () => {
    expect(IPC_CALLS.length).toBeGreaterThan(0)
    expect(IPC_EVENTS.length).toBeGreaterThan(0)
    expect(IPC_CALLS.filter((name) => (IPC_EVENTS as readonly string[]).includes(name))).toEqual([])
  })
})
