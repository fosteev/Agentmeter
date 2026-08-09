import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from '../../src/config/load.ts'
import { DEFAULT_CONFIG } from '../../src/config/types.ts'

let dir: string
const path = () => join(dir, 'config.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-cfg-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('конфиг', () => {
  it('без файла отдаёт дефолты и не жалуется', () => {
    const { config, problems } = loadConfig(path())
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(problems).toEqual([])
  })

  it('частичный конфиг дополняется дефолтами', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { warnAtPercent: 50 } }))
    const { config, problems } = loadConfig(path())
    expect(config.alerts.warnAtPercent).toBe(50)
    expect(config.alerts.dangerAtPercent).toBe(DEFAULT_CONFIG.alerts.dangerAtPercent)
    expect(problems).toEqual([])
  })

  it('вес чтения кэша по умолчанию не выдуман, а не задан', () => {
    const { config } = loadConfig(path())
    expect(config.limits.claude.cacheReadWeight).toBeNull()
  })

  it('поле не того типа заменяется дефолтом и попадает в список проблем', () => {
    writeFileSync(path(), JSON.stringify({ alerts: { warnAtPercent: 'много' } }))
    const { config, problems } = loadConfig(path())
    expect(config.alerts.warnAtPercent).toBe(DEFAULT_CONFIG.alerts.warnAtPercent)
    expect(problems).toEqual(['alerts.warnAtPercent: ожидалось number, пришло string — взят дефолт'])
  })

  it('битый JSON не роняет загрузку, но и не замалчивается', () => {
    writeFileSync(path(), '{ это не json')
    const { config, problems } = loadConfig(path())
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('не разбирается как JSON')
  })

  it('неизвестные ключи не мешают: конфиг мог написать более новый выпуск', () => {
    writeFileSync(path(), JSON.stringify({ somethingNew: { a: 1 }, ui: { theme: 'dark' } }))
    const { config, problems } = loadConfig(path())
    expect(config.ui.theme).toBe('dark')
    expect(problems).toEqual([])
  })

  it('сохранённый конфиг читается обратно без изменений', () => {
    const cfg = structuredClone(DEFAULT_CONFIG)
    cfg.limits.claude = { fiveHourCap: 44_000_000, weeklyCap: 480_000_000, cacheReadWeight: 0.1, plan: 'max20' }
    saveConfig(cfg, path())
    expect(loadConfig(path()).config).toEqual(cfg)
  })
})
