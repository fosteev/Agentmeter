/**
 * Второй источник лимитов Codex: `wham/usage` (6.4).
 *
 *     node --experimental-strip-types scripts/probe/codex-oauth-live.ts
 *     node --experimental-strip-types scripts/probe/codex-oauth-live.ts --live
 *
 * Без `--live` проба работает на эталоне и **в сеть не ходит вовсе**: она
 * прогоняется в общем ряду проверок, а сетевой вызов чужими креденшелами не
 * должен уходить оттого, что кто-то запустил проверки. С `--live` делается
 * ровно один запрос — то самое действие, которое в приложении требует
 * включённой настройки.
 *
 * Сверка здесь двойная, и вторая половина важнее первой: проценты Codex лежат
 * и в роллаутах, поэтому живой ответ можно сравнить с тем, что мы насчитали из
 * логов. Расхождение — не поломка, а ровно тот повод, ради которого этап
 * сделан: в логе процент написан в момент запроса.
 *
 * Модель — [`docs/roadmap/6.4-codex-oauth.md`](../../docs/roadmap/6.4-codex-oauth.md).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codexHome,
  ensureLimitWindows,
  indexPath,
  limitsReport,
  loadConfig,
  openDb,
  parseCodexUsage,
  type LimitWindow,
} from '../../packages/core/src/index.ts'
import { readCodexToken } from '../../apps/desktop/src/main/codex-oauth.ts'

const live = process.argv.includes('--live')
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/usage/codex-oauth.json', import.meta.url)), 'utf8'),
) as { ts: number; cases: { name: string; response: unknown; windows: LimitWindow[] }[] }
const electronBinary = createRequire(import.meta.url)('electron') as unknown
const forbidden = (): never => {
  throw new Error('проба без --live в сеть не ходит')
}
let failed = false

console.log('1. Настройка и токен')
const config = loadConfig().config
const home = codexHome(config)
console.log(`   спрашивать у OpenAI: ${config.limits.codex.api.enabled ? 'включено' : 'выключено'}`)
const { credentials, from } = readCodexToken({ codexHome: home, fetch: forbidden }, Date.now())
console.log(`   ${join(home, 'auth.json')}: ${describeCredentials(from)}`)
if (credentials?.expiresAt !== undefined) {
  console.log(`   срок токена: ${new Date(credentials.expiresAt).toISOString()}`)
}

console.log('\n2. Разбор эталонных ответов')
for (const entry of fixture.cases) {
  const windows = parseCodexUsage(entry.response, fixture.ts)
  const same = JSON.stringify(windows) === JSON.stringify(entry.windows)
  if (!same) failed = true
  console.log(`   ${same ? ' ' : '✗'} ${entry.name}: ${describe(windows)}`)
}

console.log('\n3. Что насчитано из роллаутов')
const ours = codexWindows()
if (ours.length === 0) console.log('   текущих окон Codex в индексе нет')
for (const window of ours) {
  console.log(
    `   ${window.kind} (${window.windowMinutes} мин): ${window.usedPercent}%` +
      ` · замер ${new Date(window.observedAt).toISOString()}`,
  )
}

console.log('\n4. Живой запрос')
if (!live) {
  console.log('   пропущен: нужен флаг --live')
} else {
  await ask()
}

console.log(failed ? '\nПроба красная' : '\nПроба зелёная')
process.exit(failed ? 1 : 0)

/**
 * Живой запрос — под Electron, а не отсюда.
 *
 * Из Node этот эндпоинт отвечает 403 html-страницей блокировки: Cloudflare
 * отсекает его по отпечатку TLS. Проба, ходящая не тем стеком, что приложение,
 * проверяла бы не то, поэтому запрос делает `codex-oauth-ask.cjs` под
 * настоящим Electron. `ELECTRON_RUN_AS_NODE` снимается явно — под ней Electron
 * стартует обычной нодой, и мы намерили бы ровно то, чего избегаем (пункт 11).
 */
async function ask(): Promise<void> {
  if (credentials === undefined) {
    console.log('   ✗ токена нет — авторизуйтесь в Codex')
    failed = true
    return
  }

  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const helper = fileURLToPath(new URL('./codex-oauth-ask.cjs', import.meta.url))
  let raw: string
  try {
    raw = execFileSync(String(electronBinary), [helper], {
      encoding: 'utf8',
      env,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    console.log(`   ✗ Electron не запустился: ${(error as Error).message}`)
    failed = true
    return
  }

  const line = raw.trim().split('\n').at(-1) ?? ''
  const result = JSON.parse(line) as {
    status?: number
    retryAfter?: string | null
    body?: unknown
    error?: string
  }
  if (result.error !== undefined) {
    console.log(`   ✗ ${result.error}`)
    failed = true
    return
  }
  console.log(`   HTTP ${result.status} (Chromium-стек, как в приложении)`)
  if (result.retryAfter != null) console.log(`   Retry-After: ${result.retryAfter}`)
  if (result.status !== 200) {
    // 429 и 401 — не поломка пробы, а описанное поведение источника: печатаем
    // и уходим зелёными, иначе один запрос в неудачный момент красил бы
    // проверку, ничего не сообщая о коде.
    console.log('   ответ не 200 — смотрите брифе раздел «Свежесть и отказы»')
    return
  }

  const now = Date.now()
  const windows = parseCodexUsage(result.body, now)
  if (windows.length === 0) {
    console.log('   ответ 200, окон в нём нет — так выглядит аккаунт без активных лимитов')
    return
  }
  console.log(`   ${describe(windows)}`)
  for (const window of windows) {
    console.log(`   сброс ${window.kind}: ${new Date(window.resetsAt).toISOString()}`)
    if (Number.isInteger(window.usedPercent)) continue
    console.log(`   процент дробный (${window.usedPercent}) — округлять его нельзя`)
  }

  console.log('\n5. Провайдер против роллаутов')
  for (const window of windows) {
    const mine = ours.find((one) => one.kind === window.kind)
    if (mine === undefined) {
      console.log(`   ${window.kind}: у провайдера ${window.usedPercent}%, у нас окна нет вовсе`)
      continue
    }
    const age = Math.round((now - mine.observedAt) / 60_000)
    console.log(
      `   ${window.kind}: провайдер ${window.usedPercent}%, роллауты ${mine.usedPercent}%` +
        ` (замеру ${age} мин)`,
    )
    const hours = Math.round(Math.abs(mine.resetsAt - window.resetsAt) / 3_600_000)
    if (hours > 0) console.log(`     границы расходятся на ${hours} ч — окно считается по аккаунту`)
  }
}

/** Текущие окна Codex по индексу — то, что видно без сети. */
function codexWindows(): LimitWindow[] {
  const { db } = openDb(indexPath())
  try {
    ensureLimitWindows(db, config.limits.claude)
    return limitsReport(db, Date.now(), config.limits.claude).windows.filter(
      (window) => window.provider === 'codex',
    )
  } finally {
    db.close()
  }
}

function describe(windows: readonly LimitWindow[]): string {
  if (windows.length === 0) return 'окон нет'
  return windows.map((window) => `${window.kind} ${window.usedPercent}%`).join(', ')
}

function describeCredentials(from: 'file' | 'expired' | 'missing'): string {
  if (from === 'file') return 'токен прочитан'
  if (from === 'expired') return 'токен просрочен — запустите codex'
  return 'токена нет'
}
