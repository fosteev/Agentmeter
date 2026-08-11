import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale, type UsageSnapshot } from '@agentmeter/core'
import {
  chainPath,
  claudeSettingsPath,
  drainSnapshot,
  hookPath,
  installHook,
  latestPath,
  openJournal,
  readHook,
  refreshHook,
  removeHook,
  usageStatus,
  type StatuslineHost,
} from '../src/main/statusline.ts'
import { hookBody } from '../src/main/statusline-hook.ts'

/**
 * Хук строки состояния (1.9): установка, снятие и журнал наблюдений.
 *
 * Проверки названы поломкой, которую ловят, и все они про одно: этап правит
 * **чужой** файл настроек. Потерянная чужая настройка здесь дороже любой
 * неточности в расчёте — её не восстановит ни пересборка индекса, ни повторная
 * установка.
 */

let dir: string
let host: StatuslineHost

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-statusline-'))
  setLocale('ru')
  host = { claudeHome: join(dir, 'claude'), configDir: join(dir, 'config'), platform: 'darwin' }
  mkdirSync(host.claudeHome, { recursive: true })
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

describe('установка хука', () => {
  it('прописывает команду и кладёт исполняемый файл', () => {
    expect(readHook(host).installed).toBe(false)
    const result = installHook(host)

    expect(result.problems).toEqual([])
    expect(result.previous).toBeNull()
    expect(settings()['statusLine']).toEqual({ type: 'command', command: hookPath(host) })
    expect(readFileSync(hookPath(host), 'utf8')).toBe(hookBody('darwin'))
    // Без бита исполнения Claude Code получит EACCES и промолчит: в строке
    // состояния просто ничего не появится.
    expect(statSync(hookPath(host)).mode & 0o111).toBeGreaterThan(0)
    expect(readHook(host).installed).toBe(true)
  })

  /**
   * Ловит запись поверх файла целиком. Чужие настройки Claude Code — не наше
   * дело, и потерять их установкой было бы худшим исходом этапа.
   */
  it('чужие ключи файла настроек остаются на месте', () => {
    writeSettings({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } })
    installHook(host)

    expect(settings()['model']).toBe('opus')
    expect(settings()['permissions']).toEqual({ allow: ['Bash(ls:*)'] })
  })

  /**
   * Ловит потерю чужой строки состояния: она сохраняется дословно и снятие
   * возвращает ровно её — вместе с полями помимо команды.
   */
  it('занятую строку состояния сохраняет дословно и вызывает', () => {
    const mine = { type: 'command', command: 'my-status.sh --short', padding: 0 }
    writeSettings({ statusLine: mine })

    const result = installHook(host)
    expect(result.previous).toBe(JSON.stringify(mine))
    // Команду видит и сам хук: она лежит рядом простым текстом, потому что
    // читать JSON из sh нечем.
    expect(readFileSync(chainPath(host), 'utf8')).toBe('my-status.sh --short')
    expect(readHook(host).chained).toBe('my-status.sh --short')

    removeHook(host, result.previous!)
    expect(settings()['statusLine']).toEqual(mine)
  })

  /**
   * Ловит установку поверх себя: «прежним» стал бы наш собственный хук, и
   * чужая настройка потерялась бы навсегда, причём молча.
   */
  it('повторная установка не объявляет прежним себя', () => {
    writeSettings({ statusLine: { type: 'command', command: 'my-status.sh' } })
    const first = installHook(host)
    const second = installHook(host)

    expect(first.previous).toBe(JSON.stringify({ type: 'command', command: 'my-status.sh' }))
    expect(second.previous).toBeUndefined()
    expect(readFileSync(chainPath(host), 'utf8')).toBe('my-status.sh')
  })

  /**
   * Ловит «починку» чужого файла перезаписью. Битый JSON — повод отказаться:
   * перезапись стёрла бы всё, что в нём было, и выглядела бы как успех.
   */
  it('битый файл настроек не переписывается', () => {
    writeFileSync(claudeSettingsPath(host), '{ "statusLine": ', 'utf8')
    const result = installHook(host)

    expect(result.problems).toHaveLength(1)
    expect(readFileSync(claudeSettingsPath(host), 'utf8')).toBe('{ "statusLine": ')
    expect(readHook(host).installed).toBe(false)
  })

  it('без каталога Claude Code ставить некуда, и это сказано вслух', () => {
    rmSync(host.claudeHome, { recursive: true, force: true })
    const result = installHook(host)

    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain(host.claudeHome)
  })

  /**
   * Ловит снятие чужого хука: если в строке состояния стоит не наша команда,
   * трогать её нельзя — человек поставил её после нас.
   */
  it('снятие не трогает чужую команду, вставшую поверх нашей', () => {
    installHook(host)
    writeSettings({ statusLine: { type: 'command', command: 'someone-else.sh' } })

    removeHook(host, null)
    expect(settings()['statusLine']).toEqual({ type: 'command', command: 'someone-else.sh' })
  })

  it('снятие убирает ключ, если до нас его не было', () => {
    writeSettings({ model: 'opus' })
    const result = installHook(host)

    removeHook(host, result.previous ?? null)
    expect('statusLine' in settings()).toBe(false)
    expect(settings()['model']).toBe('opus')
  })

  /**
   * Ловит хук прошлой версии, оставшийся на диске: файл лежит в каталоге
   * настроек, обновление приложения его не касается, а путь к нему записан в
   * чужом файле и меняться не должен.
   */
  it('устаревшее тело хука переписывается при старте', () => {
    installHook(host)
    writeFileSync(hookPath(host), '#!/bin/sh\necho старый\n', 'utf8')

    refreshHook(host)
    expect(readFileSync(hookPath(host), 'utf8')).toBe(hookBody('darwin'))
  })

  it('не установленный хук при старте не появляется сам', () => {
    // Установка — правка чужого файла, и разрешает её человек кнопкой.
    refreshHook(host)
    expect(readHook(host).installed).toBe(false)
  })
})

describe('журнал наблюдений', () => {
  const stdin = {
    session_id: 'aaaa',
    version: '2.1.85',
    rate_limits: {
      five_hour: { used_percentage: 13, resets_at: 1777647600 },
      seven_day: { used_percentage: 14.000000000000002, resets_at: 1777939200 },
    },
    context_window: { context_window_size: 200000 },
  }

  function drop(value: unknown, mtimeMs: number): void {
    mkdirSync(host.configDir, { recursive: true })
    writeFileSync(latestPath(host), JSON.stringify(value), 'utf8')
    // Момент наблюдения берётся из времени файла: пишет его хук, а читаем мы с
    // опозданием до периода опроса.
    const seconds = mtimeMs / 1000
    utimesSync(latestPath(host), seconds, seconds)
  }

  it('снимок доезжает до журнала с временем файла, а не «сейчас»', () => {
    const journal = openJournal(host)
    drop(stdin, 1777630200000)

    const snapshot = drainSnapshot(host, journal, 9_999_999_999_999)
    expect(snapshot?.ts).toBe(1777630200000)
    expect(snapshot?.fiveHour).toEqual({ pct: 13, resetsAt: 1777647600000 })
    expect(openJournal(host).snapshots).toHaveLength(1)
  })

  /**
   * Ловит журнал, растущий на каждую отрисовку строки состояния: хук зовётся
   * десятки раз на одно наблюдение, и без дедупа файл распух бы за день.
   */
  it('то же наблюдение второй раз не пишется', () => {
    const journal = openJournal(host)
    drop(stdin, 1777630200000)
    expect(drainSnapshot(host, journal)).not.toBeNull()

    drop(stdin, 1777630260000)
    expect(drainSnapshot(host, journal)).toBeNull()
    expect(openJournal(host).snapshots).toHaveLength(1)
  })

  /**
   * Ловит дедуп, схлопывающий запись целиком по недельному окну: оно повторя-
   * ется часами, и пятичасовые точки, ради которых всё затевалось, перестали
   * бы копиться.
   */
  it('новое пятичасовое окно пишется, даже когда недельное не изменилось', () => {
    const journal = openJournal(host)
    drop(stdin, 1777630200000)
    drainSnapshot(host, journal)

    const grown = {
      ...stdin,
      rate_limits: {
        ...stdin.rate_limits,
        five_hour: { used_percentage: 21, resets_at: 1777647600 },
      },
    }
    drop(grown, 1777630800000)
    expect(drainSnapshot(host, journal)?.fiveHour?.pct).toBe(21)
    expect(openJournal(host).snapshots).toHaveLength(2)
  })

  it('снимок без rate_limits журнал не трогает', () => {
    const journal = openJournal(host)
    drop({ session_id: 'aaaa', version: '2.1.85' }, 1777630200000)

    expect(drainSnapshot(host, journal)).toBeNull()
    expect(openJournal(host).snapshots).toEqual([] as UsageSnapshot[])
  })

  it('половина JSON на диске стоит одного наблюдения, а не падения', () => {
    const journal = openJournal(host)
    mkdirSync(host.configDir, { recursive: true })
    writeFileSync(latestPath(host), '{"rate_limits": {"five', 'utf8')

    expect(drainSnapshot(host, journal)).toBeNull()
  })

  it('статус считает снимки и окна, а вес без калибровки остаётся пустым', () => {
    const journal = openJournal(host)
    drop(stdin, 1777630200000)
    drainSnapshot(host, journal)

    const status = usageStatus(host, journal)
    expect(status.points).toBe(1)
    expect(status.windows).toBe(1)
    expect(status.weight).toBeNull()
    expect(status.installed).toBe(false)
  })
})
