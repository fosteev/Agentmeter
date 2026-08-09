import { describe, expect, it } from 'vitest'
import { dayRange } from '../../src/index.ts'

describe('dayRange', () => {
  it('якорит продуктовый день в локальной зоне и держит ровно 24 часа', () => {
    const at = new Date(2026, 7, 9, 2, 30).getTime()
    const range = dayRange(at, 4)
    const start = new Date(range.from)

    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([
      2026, 7, 8, 4,
    ])
    expect(range.to - range.from).toBe(24 * 60 * 60 * 1000)
  })

  it('сдвигает границу на календарные дни, а не часы от момента запроса', () => {
    const at = new Date(2026, 7, 9, 12).getTime()
    const current = dayRange(at, 4)
    const previous = dayRange(at, 4, -1)

    expect(current.from - previous.from).toBe(24 * 60 * 60 * 1000)
    expect(new Date(previous.from).getHours()).toBe(4)
  })

  it('отвергает час вне контракта', () => {
    expect(() => dayRange(Date.now(), 24)).toThrow(/от 0 до 23/)
  })
})
