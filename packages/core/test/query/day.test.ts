import { afterEach, describe, expect, it } from 'vitest'
import { dayRange } from '../../src/index.ts'

const originalTz = process.env['TZ']

afterEach(() => {
  if (originalTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = originalTz
})

describe('dayRange', () => {
  it('якорит продуктовый день в локальной зоне', () => {
    const at = new Date(2026, 7, 9, 2, 30).getTime()
    const range = dayRange(at, 4)
    const start = new Date(range.from)

    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([
      2026, 7, 8, 4,
    ])
    expect(new Date(range.to).getHours()).toBe(4)
  })

  it('сдвигает границу на календарные дни, а не часы от момента запроса', () => {
    const at = new Date(2026, 7, 9, 12).getTime()
    const current = dayRange(at, 4)
    const previous = dayRange(at, 4, -1)

    expect(current.from - previous.from).toBe(24 * 60 * 60 * 1000)
    expect(new Date(previous.from).getHours()).toBe(4)
  })

  /**
   * Ловит «сутки ровно 24 часа»: дважды в год день длится 23 или 25 часов, и
   * фиксированная длина заставляет соседние дни перекрываться на час или
   * разойтись на час. В первом случае расход этого часа считается дважды, во
   * втором пропадает — и то и другое молча.
   */
  describe('переход часов в Europe/Berlin', () => {
    for (const [name, day] of [
      ['весной сутки короче', '2026-03-29'],
      ['осенью сутки длиннее', '2026-10-25'],
    ] as const) {
      it(`${name}, но дни стыкуются без нахлёста и без дыры`, () => {
        process.env['TZ'] = 'Europe/Berlin'
        const at = Date.parse(`${day}T12:00:00.000Z`)

        const previous = dayRange(at, 0, -1)
        const current = dayRange(at, 0)
        const next = dayRange(at, 0, 1)

        expect(previous.to).toBe(current.from)
        expect(current.to).toBe(next.from)
        expect(current.to - current.from).not.toBe(24 * 60 * 60 * 1000)
      })
    }
  })

  it('отвергает час вне контракта', () => {
    expect(() => dayRange(Date.now(), 24)).toThrow(/от 0 до 23/)
  })
})
