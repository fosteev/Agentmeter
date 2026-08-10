/**
 * Автозапуск при входе в систему (5.3).
 *
 * **Состояние живёт в операционной системе, а не в конфиге.** Соблазн завести
 * поле в настройках велик — и он же ловушка: человек убирает Agentmeter из
 * «Объектов входа» в системных настройках, а наш тумблер продолжает гореть.
 * Два источника правды об одном факте расходятся молча, и увидеть это можно
 * только перезагрузившись. Поэтому читаем у системы и пишем в систему.
 *
 * Реализаций две, потому что механизма два. macOS и Windows умеют
 * `app.setLoginItemSettings`, Linux — нет вовсе: там автозапуск это файл
 * `~/.config/autostart/*.desktop` по спецификации XDG, и Electron его не
 * пишет. Молча вернуть `false` на Linux было бы третьим видом вранья:
 * тумблер бы щёлкал и ничего не делал.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '@agentmeter/core'

export interface StartupState {
  /** Включён ли автозапуск сейчас — по слову системы, а не по нашей памяти. */
  enabled: boolean
  /**
   * Можно ли переключать. `false` — приложение запущено не установленным: в
   * автозапуск уехал бы бинарник Electron из node_modules вместе с путём к
   * репозиторию, и после переустановки он звал бы то, чего уже нет.
   */
  available: boolean
  /** Почему переключать нельзя. Есть ровно тогда, когда `available === false`. */
  reason?: string
}

/** Минимальная часть Electron, которая здесь нужна. Остальное не касается. */
export interface StartupHost {
  isPackaged: boolean
  getLoginItemSettings: () => { openAtLogin: boolean }
  setLoginItemSettings: (settings: { openAtLogin: boolean; openAsHidden?: boolean }) => void
}

/** Имя файла XDG — оно же ключ: по нему автозапуск и находят, и снимают. */
export const LINUX_ENTRY = 'agentmeter.desktop'

export function autostartDir(): string {
  // `XDG_CONFIG_HOME` уважается, а не игнорируется: на машинах, где он
  // переставлен, запись в `~/.config` уедет мимо автозапуска — и тумблер
  // окажется тем самым переключателем без поведения.
  const base = process.env['XDG_CONFIG_HOME']
  return join(base && base.length > 0 ? base : join(homedir(), '.config'), 'autostart')
}

/**
 * Что записать в `.desktop`.
 *
 * `exec` — не `process.execPath`: внутри AppImage он указывает на распакованный
 * временный каталог, который после перезагрузки не существует. Настоящий путь
 * лежит в переменной `APPIMAGE`, и её же читает сам AppImage.
 *
 * Путь в кавычках: каталог с пробелом («/home/user/Мои программы/») иначе
 * разобьётся на два аргумента, и запись будет выглядеть исправной.
 */
export function desktopEntry(exec: string, name = 'Agentmeter'): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Exec="${exec}"`,
    'Terminal=false',
    // Приложение живёт в трее и окна при старте не открывает — это не «скрытый
    // режим», а обычный его вид. Флаг всё равно нужен: без него GNOME считает
    // запись «Hidden=true» отключённой.
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export function launchPath(): string {
  return process.env['APPIMAGE'] ?? process.execPath
}

/**
 * Платформа приезжает параметром, а не читается из `process`.
 *
 * Иначе линуксовая ветка — единственная, написанная руками и потому самая
 * ошибкоопасная, — проверялась бы только на Linux, то есть у меня никогда.
 */
export function readStartup(host: StartupHost, platform = process.platform): StartupState {
  if (!host.isPackaged) {
    return { enabled: false, available: false, reason: t('settings.launchUnpackaged') }
  }
  if (platform === 'linux') {
    const path = join(autostartDir(), LINUX_ENTRY)
    // Файл может лежать с `X-GNOME-Autostart-enabled=false` — так его гасит
    // системный интерфейс, не удаляя. Считать такое включённым значит показать
    // «да» там, где система говорит «нет».
    const enabled =
      existsSync(path) && !readFileSync(path, 'utf8').includes('X-GNOME-Autostart-enabled=false')
    return { enabled, available: true }
  }
  return { enabled: host.getLoginItemSettings().openAtLogin, available: true }
}

export function writeStartup(
  host: StartupHost,
  enabled: boolean,
  platform = process.platform,
): StartupState {
  const state = readStartup(host, platform)
  if (!state.available) return state
  if (platform === 'linux') {
    const dir = autostartDir()
    const path = join(dir, LINUX_ENTRY)
    if (enabled) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, desktopEntry(launchPath()))
    } else rmSync(path, { force: true })
    return readStartup(host, platform)
  }
  // `openAsHidden` — только macOS, и на нём же он и нужен: без него система
  // покажет окно приложения при входе, а окна у трея при старте нет вовсе.
  host.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
  return readStartup(host, platform)
}
