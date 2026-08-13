/**
 * Снятие хука строки состояния — всё, что от него осталось (7.5).
 *
 * Хук ставился в `~/.claude/settings.json` до 7.5 и добывал проценты лимита
 * Claude из JSON, который Claude Code подаёт своей строке состояния (1.9). Из
 * интерфейса он снят вместе с потолками плана — и не потому, что сложен, а
 * потому, что не работает у половины: строку состояния рисует только
 * терминальный CLI, в VS Code её нет вовсе. На живой машине хук простоял месяц
 * и не дал **ни одного** наблюдения, пока рядом копились 54 ответа провайдера
 * (6.3). Экран, на котором тумблер месяцами показывает «0 снимков», сообщает о
 * себе только собственную бесполезность.
 *
 * Но убрать тумблер и уйти нельзя: запись осталась бы в **чужом** файле
 * настроек навсегда, и Claude Code продолжал бы звать скрипт, который никто
 * больше не читает, — а снять его человеку стало бы нечем. Поэтому модуль
 * пережил свою настройку в одном качестве: разовой уборкой при старте.
 *
 * Правила уборки ровно те же, что были у снятия по кнопке:
 *
 * - трогаем **только свою** запись: `statusLine`, указывающий на чужую команду,
 *   не наш и не наше дело;
 * - прежнее значение возвращается дословно — оно и лежало в конфиге ради этого;
 * - битый JSON — повод отступить, а не переписать: перезапись «починила бы»
 *   чужой файл, стерев всё, что в нём было.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Что модулю нужно от машины: два каталога и платформа (у хука имя разное). */
export interface StatuslineHost {
  /** Каталог настроек Claude Code: там `settings.json`. */
  claudeHome: string
  /** Каталог настроек Agentmeter: там лежали хук и цепочка. */
  configDir: string
  /**
   * Платформа приезжает параметром, а не читается из `process`: ветка Windows
   * иначе проверялась бы только на Windows, то есть у меня никогда.
   */
  platform: NodeJS.Platform
}

export function hookPath(host: StatuslineHost): string {
  const name = host.platform === 'win32' ? 'statusline-hook.cmd' : 'statusline-hook.sh'
  return join(host.configDir, name)
}

export function claudeSettingsPath(host: StatuslineHost): string {
  return join(host.claudeHome, 'settings.json')
}

export interface CleanupResult {
  /** Запись в чужом файле нашлась и снята — поводу написать в лог. */
  removed: boolean
  /** Не вышло: файл не разбирается или не пишется. Уборка молча отступает. */
  problem?: string
}

/**
 * Убрать хук, если он ещё стоит, и стереть его следы в своём каталоге.
 *
 * Идемпотентна: чужого `statusLine` не касается, отсутствие файлов считает
 * нормой и при любом отказе оставляет всё как было. Зовётся при старте — то
 * есть у всех, включая тех, кто хук никогда не ставил, и для них она сводится к
 * одному чтению `settings.json`.
 *
 * `previous` — то, что стояло в строке состояния до нас (лежит в нашем конфиге
 * дословным JSON). `null` означает «до нас там не было ничего», и тогда ключ
 * удаляется целиком.
 */
export function dropStatusline(host: StatuslineHost, previous: string | null): CleanupResult {
  const path = hookPath(host)
  const settings = readSettings(host)
  if (settings.problem !== undefined) return { removed: false, problem: settings.problem }

  let removed = false
  const data = settings.data
  if (data !== undefined && commandOf(data['statusLine']) === path) {
    const restored = parse(previous)
    if (restored === undefined) delete data['statusLine']
    else data['statusLine'] = restored
    const problem = writeSettings(host, data)
    if (problem !== undefined) return { removed: false, problem }
    removed = true
  }

  // Свои файлы убираются и тогда, когда в чужих настройках нас уже нет:
  // человек мог снести запись руками, а скрипт со снимком остались бы лежать.
  // Журнал наблюдений при этом остаётся: он не про хук, а про лимиты, и
  // ретроспективе не поддаётся — процент сброшенного окна не узнает никто.
  for (const name of ['statusline-prev', 'usage-latest.json']) {
    rmSync(join(host.configDir, name), { force: true })
  }
  rmSync(path, { force: true })
  return { removed }
}

interface SettingsRead {
  data?: Record<string, unknown>
  problem?: string
}

function readSettings(host: StatuslineHost): SettingsRead {
  const path = claudeSettingsPath(host)
  if (!existsSync(path)) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { problem: `${path}: not an object` }
    }
    return { data: raw as Record<string, unknown> }
  } catch (error) {
    return { problem: `${path}: ${(error as Error).message}` }
  }
}

function writeSettings(host: StatuslineHost, data: Record<string, unknown>): string | undefined {
  const path = claudeSettingsPath(host)
  try {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return `${path}: ${(error as Error).message}`
  }
}

/** Команда из значения `statusLine` — оно бывает объектом и бывает строкой. */
function commandOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const command = (value as Record<string, unknown>)['command']
  return typeof command === 'string' ? command : undefined
}

function parse(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
