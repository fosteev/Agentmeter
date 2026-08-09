/**
 * Та же сверка с эталоном, что и в `ground-truth-check.py`, но нашим парсером.
 *
 *     node --experimental-strip-types scripts/probe/verify-live.ts
 *
 * Смысл в дублировании: python-скрипт и `packages/core` — две независимые
 * реализации одной модели. Пока их цифры совпадают до токена, ошибка в
 * понимании данных исключена; разойдутся — значит кто-то из двоих сломался,
 * и это видно сразу, а не через месяц в интерфейсе.
 *
 * Зародыш команды `agentmeter verify` (1.3). Ненулевой код возврата здесь
 * ожидаем: хвостовые служебные запросы следа в логах не оставляют.
 */
import { globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseSessionFile, parseSubagents } from '../../packages/core/src/index.ts'
import { sumRequests } from '../../packages/core/src/verify/compare.ts'

interface ProjectEntry {
  lastSessionId?: string
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
}

const full = process.argv.includes('--full')

const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
  projects?: Record<string, ProjectEntry>
}
const files = new Map<string, string>()
for (const p of globSync(join(homedir(), '.claude/projects/*/*.jsonl'))) {
  files.set(basename(p, '.jsonl'), p)
}

let checked = 0
let exact = 0
let empty = 0
let worst = 0

console.log(
  `${'проект'.padEnd(18)} ${'Δ чтения'.padStart(11)} ${'%'.padStart(7)} ` +
    `${'Δ записи'.padStart(9)} ${'восст.'.padStart(6)} ${'саб.'.padStart(4)}`,
)

for (const [name, proj] of Object.entries(cfg.projects ?? {})) {
  const sid = proj.lastSessionId
  const expectedCacheRead = proj.lastTotalCacheReadInputTokens ?? 0
  if (!sid || !expectedCacheRead) continue
  const path = files.get(sid)
  if (!path) continue

  const { requests } = parseSessionFile(path)
  if (requests.length === 0) {
    // Файл есть, а запросов в нём нет: сессия оборвалась, эталон относится к
    // чему-то другому. Это не расхождение, это отсутствие данных.
    empty += 1
    continue
  }

  const subagents = parseSubagents(path)
  const totals = sumRequests(requests)
  if (full) {
    for (const sub of subagents) {
      const s = sumRequests(sub.requests)
      totals.input += s.input
      totals.output += s.output
      totals.cacheWrite += s.cacheWrite
      totals.cacheRead += s.cacheRead
    }
  }

  // Хвостовой служебный запрос: после последнего ответа сессии он уходит, но
  // следа не оставляет. Считаем ровно один — их бывает от нуля до трёх.
  const last = requests.filter((r) => r.origin === 'log').at(-1)
  if (last) {
    totals.cacheRead += last.cacheRead + last.cacheWrite
    totals.cacheWrite += last.output
  }

  const dCacheRead = expectedCacheRead - totals.cacheRead
  const dCacheWrite = (proj.lastTotalCacheCreationInputTokens ?? 0) - totals.cacheWrite
  const drift = dCacheRead / expectedCacheRead
  checked += 1
  if (dCacheRead === 0 && dCacheWrite === 0) exact += 1
  worst = Math.max(worst, Math.abs(drift))

  const reconstructed = requests.filter((r) => r.origin === 'reconstructed').length
  console.log(
    `${basename(name).slice(0, 18).padEnd(18)} ${String(dCacheRead).padStart(11)} ` +
      `${(drift * 100).toFixed(2).padStart(6)}% ${String(dCacheWrite).padStart(9)} ` +
      `${String(reconstructed).padStart(6)} ${String(subagents.length).padStart(4)}`,
  )
}

console.log(
  `\nсошлось точно: ${exact} из ${checked}, худшее расхождение ${(worst * 100).toFixed(2)}%, ` +
    `сессий без запросов: ${empty}`,
)
console.log('Полный расход сабагентов (эталон его недосчитывает): --full')
process.exit(exact === checked ? 0 : 1)
