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
