import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeSettingsPath, dropStatusline, hookPath, type StatuslineHost } from '../src/main/statusline.ts'

/**
 * Уборка за снятым хуком строки состояния (7.5).
 *
 * Настройка ушла из интерфейса вместе с потолками, а запись осталась бы в
 * **чужом** файле навсегда: Claude Code продолжал бы звать скрипт, которого
 * никто не читает, и снять его человеку стало бы нечем. Отсюда разовая уборка
 * при старте — и проверки на неё названы поломкой, которую ловят.
 *
 * Дороже всего здесь не хук, а соседи по файлу: потерянная чужая настройка не
 * восстанавливается ничем.
 */

let dir: string
let host: StatuslineHost

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-statusline-'))
  host = { claudeHome: join(dir, 'claude'), configDir: join(dir, 'config'), platform: 'darwin' }
  mkdirSync(host.claudeHome, { recursive: true })
  mkdirSync(host.configDir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeSettingsPath(host), 'utf8'))
}

function writeSettings(value: Record<string, unknown>): void {
  writeFileSync(claudeSettingsPath(host), JSON.stringify(value, null, 2), 'utf8')
}

/** Как выглядел диск у того, кто хук включал: запись у Claude Code, файлы у нас. */
function installed(previous?: Record<string, unknown>): void {
  writeSettings({
    model: 'opus',
    statusLine: { type: 'command', command: hookPath(host) },
    ...(previous ?? {}),
  })
  writeFileSync(hookPath(host), '#!/bin/sh\n', 'utf8')
  writeFileSync(join(host.configDir, 'usage-latest.json'), '{}', 'utf8')
}

describe('уборка за хуком', () => {
  it('снимает свою запись и не трогает соседние ключи', () => {
    installed()

    expect(dropStatusline(host, null)).toEqual({ removed: true })
    expect('statusLine' in settings()).toBe(false)
    expect(settings()['model']).toBe('opus')
  })

  /**
   * Ловит уборку, теряющую чужую строку состояния: она стояла до нас, хук её
   * вызывал, и после снятия человек обязан получить ровно то, что было.
   */
  it('возвращает прежнюю команду дословно', () => {
    installed()
    const previous = JSON.stringify({ type: 'command', command: 'my-status.sh --short' })

    expect(dropStatusline(host, previous).removed).toBe(true)
    expect(settings()['statusLine']).toEqual({ type: 'command', command: 'my-status.sh --short' })
  })

  /**
   * Ловит уборку, сносящую чужой хук: строка состояния могла быть переписана
   * после нас, и тогда запись не наша.
   */
  it('чужую команду поверх нашей не трогает', () => {
    installed()
    writeSettings({ statusLine: { type: 'command', command: 'someone-else.sh' } })

    expect(dropStatusline(host, null)).toEqual({ removed: false })
    expect(settings()['statusLine']).toEqual({ type: 'command', command: 'someone-else.sh' })
  })

  /**
   * Ловит перезапись битого файла: «починить» его нашей записью значит стереть
   * всё, что в нём было.
   */
  it('битый файл настроек не переписывается', () => {
    writeFileSync(claudeSettingsPath(host), '{ не json', 'utf8')

    const result = dropStatusline(host, null)
    expect(result.removed).toBe(false)
    expect(result.problem).toContain('settings.json')
    expect(readFileSync(claudeSettingsPath(host), 'utf8')).toBe('{ не json')
  })

  it('свои файлы стирает и тогда, когда запись человек убрал руками', () => {
    installed()
    writeSettings({ model: 'opus' })

    expect(dropStatusline(host, null).removed).toBe(false)
    expect(existsSync(hookPath(host))).toBe(false)
    expect(existsSync(join(host.configDir, 'usage-latest.json'))).toBe(false)
  })

  /**
   * Ловит уборку, которая при каждом старте объявляет себя сделавшей дело:
   * `removed` включает запись в конфиг, и вечное `true` писало бы его на каждый
   * запуск приложения.
   */
  it('второй раз ничего не находит и молчит', () => {
    installed()
    dropStatusline(host, null)

    expect(dropStatusline(host, null)).toEqual({ removed: false })
  })

  it('у того, кто хук не ставил, ничего не портит', () => {
    writeSettings({ model: 'opus', statusLine: 'my-status.sh' })

    expect(dropStatusline(host, null)).toEqual({ removed: false })
    expect(settings()['statusLine']).toBe('my-status.sh')
  })

  it('без файла настроек Claude Code уборка молча ничего не делает', () => {
    expect(dropStatusline(host, null)).toEqual({ removed: false })
  })
})
