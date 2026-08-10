import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@agentmeter/core'
import {
  LINUX_ENTRY,
  autostartDir,
  desktopEntry,
  readStartup,
  writeStartup,
  type StartupHost,
} from '../src/main/startup.ts'

/**
 * Автозапуск (5.3).
 *
 * Платформа во всех вызовах — параметр, и это единственный способ проверить
 * линуксовую ветку: она написана руками (Electron автозапуск на Linux не умеет
 * вовсе), то есть самая ошибкоопасная из трёх, — а машины с Linux у меня нет.
 * Проверять её только там, где она запускается, значит не проверять никогда.
 *
 * Файловая часть идёт в подменённый `XDG_CONFIG_HOME`: иначе тест писал бы в
 * автозапуск того, кто его прогнал.
 */

let dir: string
const wasXdg = process.env['XDG_CONFIG_HOME']

/** Подделка `app`: помнит записанное и отвечает им — как настоящая система. */
function host(packaged = true, openAtLogin = false): StartupHost & { openAtLogin: boolean } {
  return {
    isPackaged: packaged,
    openAtLogin,
    getLoginItemSettings() {
      return { openAtLogin: this.openAtLogin }
    },
    setLoginItemSettings(settings: { openAtLogin: boolean }) {
      this.openAtLogin = settings.openAtLogin
    },
  }
}

beforeEach(() => {
  setLocale('ru')
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-startup-'))
  process.env['XDG_CONFIG_HOME'] = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (wasXdg === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = wasXdg
})

describe('автозапуск', () => {
  /**
   * Ловит тумблер, показывающий желаемое вместо действительного. Ответ обязан
   * быть перечитан у системы: она вправе не разрешить, и «включено», которого
   * нет, — самое проверяемое враньё в продукте.
   */
  it('macOS и Windows: состояние спрашивается у системы, а не помнится', () => {
    const app = host()

    expect(readStartup(app, 'darwin').enabled).toBe(false)
    expect(writeStartup(app, true, 'darwin').enabled).toBe(true)
    expect(app.openAtLogin).toBe(true)
    expect(writeStartup(app, false, 'darwin').enabled).toBe(false)
    expect(app.openAtLogin).toBe(false)

    // Система передумала сама — приложение обязано показать её ответ, а не свой.
    app.openAtLogin = true
    expect(readStartup(app, 'darwin').enabled).toBe(true)
  })

  /**
   * Ловит линуксовую ветку, которая молча ничего не делает: `setLoginItemSettings`
   * там не работает вовсе, и тумблер щёлкал бы вхолостую.
   */
  it('Linux: пишется файл XDG, и снимается тоже он', () => {
    const app = host()

    const on = writeStartup(app, true, 'linux')

    const path = join(autostartDir(), LINUX_ENTRY)
    expect(on.enabled).toBe(true)
    expect(existsSync(path)).toBe(true)
    // Каталог — из `XDG_CONFIG_HOME`, а не из `~/.config` вслепую.
    expect(path.startsWith(dir)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('[Desktop Entry]')
    expect(text).toContain('X-GNOME-Autostart-enabled=true')
    // Системный вызов при этом не трогается: на Linux он ничего не значит.
    expect(app.openAtLogin).toBe(false)

    expect(writeStartup(app, false, 'linux').enabled).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  /**
   * Ловит чтение «файл есть — значит включено». Системный интерфейс GNOME гасит
   * запись строкой, не удаляя файл, и тумблер показывал бы «да» там, где
   * система говорит «нет».
   */
  it('Linux: погашенная запись читается как выключенная', () => {
    mkdirSync(autostartDir(), { recursive: true })
    writeFileSync(
      join(autostartDir(), LINUX_ENTRY),
      desktopEntry('/opt/Agentmeter/agentmeter').replace(
        'X-GNOME-Autostart-enabled=true',
        'X-GNOME-Autostart-enabled=false',
      ),
    )

    expect(readStartup(host(), 'linux').enabled).toBe(false)
  })

  /**
   * Ловит путь с пробелом, разобранный как два аргумента: запись выглядела бы
   * исправной, а автозапуск не срабатывал бы — и увидеть это можно только
   * перезагрузившись.
   */
  it('путь в записи закавычен', () => {
    expect(desktopEntry('/home/u/Мои программы/Agentmeter.AppImage')).toContain(
      'Exec="/home/u/Мои программы/Agentmeter.AppImage"',
    )
  })

  /**
   * Ловит тумблер, который в разработке пишет в автозапуск путь к бинарнику
   * Electron из node_modules. Он бы даже сработал — до первой переустановки
   * зависимостей, после которой система звала бы то, чего нет.
   */
  it('в неустановленном приложении переключать нельзя, и сказано почему', () => {
    const app = host(false)

    const state = readStartup(app, 'darwin')
    expect(state.available).toBe(false)
    expect(state.reason).toBeTruthy()

    // Попытка включить не делает ничего — ни в системе, ни на диске.
    expect(writeStartup(app, true, 'darwin').enabled).toBe(false)
    expect(app.openAtLogin).toBe(false)
    expect(writeStartup(app, true, 'linux').enabled).toBe(false)
    expect(existsSync(join(autostartDir(), LINUX_ENTRY))).toBe(false)
  })
})
