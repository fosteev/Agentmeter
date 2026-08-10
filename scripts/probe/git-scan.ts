/**
 * Ветка и ключ тикета на живых логах (3.7).
 *
 *     node --experimental-strip-types scripts/probe/git-scan.ts
 *
 * Правило извлечения ключа — измерение, а не вкус: строгая форма `GARM-802`
 * находит ключ у 9 сессий из 616 и не ошибается ни разу, а та же форма без
 * учёта регистра объявляет тикетом ветку `refactor/phase-3-sensors`. Проба
 * держит обе стороны: что настоящие ключи находятся и что похожее на ключ
 * ключом не становится.
 *
 * Здесь же сторож на `HEAD`: Claude Code пишет его в `gitBranch` у трети
 * сессий с веткой, и это не имя ветки, а отсоединённое состояние — веткой с
 * таким именем git быть запрещает.
 *
 * Каждая проверка названа поломкой, которую ловит.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dayRange,
  DEFAULT_CONFIG,
  daySplits,
  defaultClaudeHome,
  defaultCodexHome,
  ingestAll,
  openDb,
  taskRows,
  ticketKey,
} from '../../packages/core/src/index.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-git-scan-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  ingestAll(db, { claudeHome: defaultClaudeHome(), codexHome: defaultCodexHome() })
  const sessions = db.all<{ branch: string | null; provider: string }>(
    'SELECT branch, provider FROM sessions',
  )
  const named = sessions.filter((row) => row.branch !== null && row.branch !== '')
  const unique = new Set(named.map((row) => row.branch!))
  report(
    1,
    'ветки в индексе есть, и их можно пересчитать',
    `сессий=${sessions.length}, с веткой=${named.length}, разных имён=${unique.size}`,
    named.length > 0,
  )

  // Ловит возвращение `HEAD` в колонку «Проект · ветка». Отсеивается он в
  // парсере, и правка соседнего кода легко вернёт его обратно: сессия при этом
  // будет выглядеть работавшей в ветке с таким именем, которой не бывает.
  const heads = named.filter((row) => row.branch === 'HEAD')
  report(
    2,
    'HEAD в индекс не попадает',
    `сессий с branch = HEAD: ${heads.length}`,
    heads.length === 0,
  )

  // Ловит правило, начавшее ошибаться. Список известных «не тикетов» взят с
  // диска: это все имена веток, в которых ключа нет, — и появление среди них
  // хоть одного «найденного» значит, что правило поехало.
  const keys = new Map<string, number>()
  const wrong: string[] = []
  for (const branch of unique) {
    const key = ticketKey(branch)
    if (key === null) continue
    // Ключ обязан быть виден в имени **как есть и заглавными**. Первое ловит
    // значение, вытащенное «по смыслу», — сверить его не с чем. Второе ловит
    // ослабление правила до нечувствительности к регистру: тогда ключом
    // становится `phase-3` из ветки `refactor/phase-3-sensors`, и по одному
    // только числу найденных ключей этого не видно.
    if (!branch.includes(key) || key !== key.toUpperCase()) wrong.push(`${branch} → ${key}`)
    keys.set(key, (keys.get(key) ?? 0) + 1)
  }
  const loose = [...unique].filter(
    (branch) => ticketKey(branch) === null && /\b[A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}\b/.test(branch),
  )
  report(
    3,
    'ключ тикета находится строгой формой, а нестрогая ловит лишнее',
    `ключей=${keys.size} (${[...keys.keys()].join(', ') || 'нет'}); нестрогая нашла бы ещё ${loose.length}: ${loose.join(', ') || 'нечего'}`,
    wrong.length === 0 && keys.size > 0,
  )

  // Ловит разрез, посчитанный не по своим сессиям: сумма тикета обязана
  // сойтись с суммой задач, у которых этот ключ, — на каждом дне.
  const days = db
    .all<{ start: number }>(
      `SELECT min(ts) AS start FROM requests
        GROUP BY date(ts / 1000, 'unixepoch', 'localtime') ORDER BY start`,
    )
    .map((row) => dayRange(row.start, DEFAULT_CONFIG.ui.dayStartsAtHour))
  const mismatched: string[] = []
  let ticketDays = 0
  for (const day of days) {
    const tickets = daySplits(db, day).tickets
    if (tickets.length > 0) ticketDays += 1
    const rows = taskRows(db, day, {}, { foldSubagents: false })
    for (const ticket of tickets) {
      const fromTasks = rows
        .filter((row) => row.ticket === ticket.ticket)
        .reduce((sum, row) => sum + row.totals.total, 0)
      if (fromTasks !== ticket.total) {
        mismatched.push(`${ticket.ticket}: разрез ${ticket.total} против задач ${fromTasks}`)
      }
    }
  }
  report(
    4,
    'разрез по тикетам сходится с задачами этих тикетов',
    `дней с тикетами=${ticketDays} из ${days.length}, расхождений=${mismatched.length}${mismatched[0] ? ` · ${mismatched[0]}` : ''}`,
    ticketDays > 0 && mismatched.length === 0,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

function report(number: number, name: string, detail: string, ok: boolean): void {
  if (!ok) failed = true
  console.log(`${ok ? '✅' : '❌'} ${number}. ${name}\n   ${detail}`)
}

process.exit(failed ? 1 : 0)
