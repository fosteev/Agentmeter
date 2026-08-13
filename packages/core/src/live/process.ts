/**
 * Проверка процессов: жив ли и когда стартовал.
 *
 * Второе нужно не из любопытства. Файл сессии остаётся на диске после падения
 * агента, а система рано или поздно выдаёт тот же pid другому процессу — и
 * тогда `kill(pid, 0)` честно отвечает «жив» про чужого, а в трее навсегда
 * повисает работающий агент. Отличить можно только по времени старта: наш
 * процесс стартовал тогда же, когда написан файл сессии.
 *
 * Кросс-платформенного способа взять время старта из Node нет. Linux читает
 * `/proc`, macOS зовёт `ps` **одним вызовом на все pid сразу**, Windows не
 * умеет вовсе — там проверка отключена, и это записано как известное
 * ограничение, а не замаскировано правдоподобной заглушкой.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** `alive` — наш живой процесс, `foreign` — чужой (EPERM), `gone` — нет такого. */
export type ProcessState = 'alive' | 'foreign' | 'gone'

export function processState(pid: number): ProcessState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'gone'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    // EPERM означает «процесс есть, но не наш» — почти всегда это переиспользо-
    // ванный pid чужого пользователя. Показывать его как своего агента нельзя,
    // но и путать с «процесса нет» не надо: причины разные.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'foreign' : 'gone'
  }
}

/**
 * Момент старта процессов, мс. Отсутствие ключа означает «узнать не удалось» —
 * это не то же самое, что «процесс мёртв».
 */
export function processStartTimes(pids: readonly number[]): Map<number, number> {
  const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (unique.length === 0) return new Map()
  if (process.platform === 'linux') return linuxStartTimes(unique)
  if (process.platform === 'darwin') return darwinStartTimes(unique)
  return new Map()
}

function linuxStartTimes(pids: readonly number[]): Map<number, number> {
  const boot = linuxBootTime()
  const out = new Map<number, number>()
  if (boot === undefined) return out

  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // Имя команды в скобках может содержать что угодно, включая пробелы и
      // скобки, поэтому поля считаются от последней закрывающей, а не сплитом.
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      // Поле 22 в man 5 proc; после отрезанных pid и comm оно двадцатое.
      const ticks = Number(tail[19])
      if (!Number.isFinite(ticks)) continue
      out.set(pid, boot + (ticks / LINUX_CLOCK_TICKS) * 1000)
    } catch {
      // Процесс умер между списком и чтением — не наша забота, его не будет
      // и в проверке живости.
    }
  }
  return out
}

// USER_HZ из Node не виден, а `getconf CLK_TCK` — ещё один процесс на опрос.
// На всех живых Linux это 100; ошибка здесь сдвигает время старта, а не
// решение, потому что сверка идёт с допуском в минуты.
const LINUX_CLOCK_TICKS = 100

function linuxBootTime(): number | undefined {
  try {
    const btime = readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]
    return btime === undefined ? undefined : Number(btime) * 1000
  } catch {
    return undefined
  }
}

function darwinStartTimes(pids: readonly number[]): Map<number, number> {
  const out = new Map<number, number>()
  try {
    // Один вызов на все pid: `ps` в цикле по десятку сессий каждую секунду —
    // это десяток процессов в секунду ради данных, которые не меняются.
    const stdout = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
      timeout: 2_000,
    })
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      // `ps` печатает время в локальной зоне — здесь это правильно, потому что
      // Date.parse без указания зоны тоже читает локальную. Ловушка ровно
      // обратная лежит в файле сессии: там то же самое написано в UTC.
      const parsed = Date.parse(match[2]!)
      if (!Number.isNaN(parsed)) out.set(Number(match[1]), parsed)
    }
  } catch {
    // Нет `ps`, таймаут, песочница — проверка просто не выполняется.
  }
  return out
}

/**
 * Приложение, которому принадлежит процесс агента (7.6).
 *
 * Нужно ровно для одного: клик по уведомлению «агент закончил» должен поднять
 * ту программу, в которой агент работает, а не наше окно. Взять её из файла
 * сессии нельзя — `entrypoint` там `claude-vscode` у VS Code, Cursor и
 * Windsurf одинаково, то есть отличает вид оболочки, а не программу.
 * Измеряется это цепочкой `ppid`: на живой машине от процесса агента до
 * бандла три прыжка (`claude` → `Cursor Helper (Plugin): extension-host` →
 * `/Applications/Cursor.app/Contents/MacOS/Cursor`).
 *
 * **До окна цепочка не доводит, и это граница, а не недоделка.** Хост
 * расширений один на окно, но окно у него не спросить: 19 живых сессий на
 * машине висели на трёх хостах, шесть из них — на одном. Указателя на чат
 * внутри окна нет ни в реестре, ни в транскрипте.
 */
export interface OwnerApp {
  /** Путь к бандлу: `/Applications/Cursor.app`. */
  bundle: string
  /** Имя без `.app` — то, что человек видит в Dock. */
  name: string
}

/** Строка таблицы процессов. `command` — путь или заголовок, как отдал `ps`. */
export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

/**
 * Владельцы процессов, одним вызовом `ps` на всех.
 *
 * Только macOS. На Windows и Linux карта пустая, и это то же решение, что у
 * `processStartTimes`: поднять чужое окно на Wayland композитор не даёт вовсе,
 * а на Windows мешает foreground lock, — правдоподобная заглушка здесь дала бы
 * уведомление, которое иногда открывает не то.
 */
export function ownerApps(pids: readonly number[]): Map<number, OwnerApp> {
  const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (process.platform !== 'darwin' || unique.length === 0) return new Map()
  try {
    // Вся таблица разом: цепочка идёт вверх на неизвестную глубину, и спрашивать
    // `ps` про каждого родителя отдельно — это процесс на прыжок.
    const stdout = execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return resolveOwners(parseProcessTable(stdout), unique)
  } catch {
    return new Map()
  }
}

export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    // Имя команды содержит пробелы и скобки («Cursor Helper (Plugin):
    // extension-host (user) Agentmeter [1-1]»), поэтому режется два первых
    // поля, а остальное берётся как есть.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! })
  }
  return rows
}

export function resolveOwners(
  rows: readonly ProcessRow[],
  pids: readonly number[],
): Map<number, OwnerApp> {
  const table = new Map(rows.map((row) => [row.pid, row]))
  const out = new Map<number, OwnerApp>()
  for (const pid of pids) {
    const owner = walkUp(table, pid)
    if (owner !== undefined) out.set(pid, owner)
  }
  return out
}

/**
 * Вверх по родителям до первого бандла.
 *
 * Глубина ограничена не из осторожности вообще: `ppid` в таблице приезжает от
 * ОС, процесс между строками может умереть и переродиться, и цикл здесь
 * повесил бы опрос трея намертво.
 */
function walkUp(table: Map<number, ProcessRow>, pid: number): OwnerApp | undefined {
  const seen = new Set<number>()
  let current = pid
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    if (current <= 1 || seen.has(current)) return undefined
    seen.add(current)
    const row = table.get(current)
    if (row === undefined) return undefined
    const owner = bundleOf(row.command)
    if (owner !== undefined) return owner
    current = row.ppid
  }
  return undefined
}

const MAX_PARENT_DEPTH = 16

/**
 * Бандл из пути к исполняемому файлу — **внешний**, а не ближайший.
 *
 * Хелперы Electron лежат внутри бандла своего приложения
 * (`Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/…`), и поиск
 * последнего `.app` в пути выдал бы «Cursor Helper (Plugin)»: имя, которого нет
 * ни в Dock, ни в `open -a`. Берётся первый `.app` в пути, а `Contents/MacOS`
 * требуется только как признак бандла — где угодно дальше по строке.
 */
export function bundleOf(command: string): OwnerApp | undefined {
  if (!command.startsWith('/') || !command.includes('/Contents/MacOS/')) return undefined
  const at = command.indexOf('.app/')
  if (at < 0) return undefined
  const bundle = command.slice(0, at + '.app'.length)
  const name = bundle.slice(bundle.lastIndexOf('/') + 1, -'.app'.length)
  return name === '' ? undefined : { bundle, name }
}
