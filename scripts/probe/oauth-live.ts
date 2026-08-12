/**
 * Второй источник настоящих лимитов: `/api/oauth/usage` (6.3).
 *
 *     node --experimental-strip-types scripts/probe/oauth-live.ts
 *     node --experimental-strip-types scripts/probe/oauth-live.ts --live
 *
 * Без `--live` проба работает на фикстурах и **в сеть не ходит вовсе**: она
 * прогоняется в общем ряду проверок, а сетевой вызов чужими креденшелами не
 * должен уходить оттого, что кто-то запустил проверки. С `--live` делается
 * ровно один запрос — и это то самое действие, которое в приложении требует
 * включённой настройки.
 *
 * Модель — [`docs/roadmap/6.3-oauth-usage.md`](../../docs/roadmap/6.3-oauth-usage.md).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  CALIBRATION,
  loadConfig,
  parseOauthUsage,
  parseRetryAfter,
  readUsageJournal,
  usagePath,
  type UsageSnapshot,
} from '../../packages/core/src/index.ts'
import { readToken } from '../../apps/desktop/src/main/oauth.ts'

const live = process.argv.includes('--live')
const fixtures = fileURLToPath(new URL('../../fixtures/oauth/', import.meta.url))
const electronBinary = createRequire(import.meta.url)('electron') as unknown
let failed = false

console.log('1. Настройка и токен')
const config = loadConfig().config
const claudeHome = config.sources.claudeHome ?? join(process.env['HOME'] ?? '', '.claude')
console.log(`   спрашивать у Anthropic: ${config.limits.claude.api.enabled ? 'включено' : 'выключено'}`)
const { from } = readToken({ claudeHome, platform: process.platform, fetch: forbidden })
console.log(`   токен: ${describeCredentials(from)}`)

console.log('\n2. Разбор эталонных ответов')
for (const name of ['usage-live.json', 'usage-models.json']) {
  const body: unknown = JSON.parse(readFileSync(fixtures + name, 'utf8'))
  const snapshot = parseOauthUsage(body, Date.now())
  if (snapshot === null) {
    console.log(`   ✗ ${name}: не разобрался`)
    failed = true
    continue
  }
  console.log(`   ${name}: ${describe(snapshot)}`)
}

console.log('\n3. Retry-After')
// Ноль здесь — не крайний случай, а наблюдавшееся поведение эндпоинта: он
// отдаёт `0` и продолжает отказывать.
for (const value of ['30', '0', 'Tue, 11 Aug 2026 20:05:00 GMT', 'мусор']) {
  const at = Date.parse('2026-08-11T20:00:00Z')
  const parsed = parseRetryAfter(value, at)
  console.log(`   ${JSON.stringify(value)} → ${parsed === undefined ? 'не верим, ждём 5 мин' : `${parsed / 1000} с`}`)
}
if (parseRetryAfter('0', Date.now()) !== undefined) {
  console.log('   ✗ ноль принят за «можно сразу»')
  failed = true
}

console.log('\n4. Журнал наблюдений')
const journal = readUsageJournal(usagePath())
const bySource = new Map<string, number>()
for (const snapshot of journal) {
  const key = snapshot.source ?? 'statusline'
  bySource.set(key, (bySource.get(key) ?? 0) + 1)
}
console.log(`   ${usagePath()}`)
console.log(`   снимков: ${journal.length}${journal.length === 0 ? ' — пока пусто, это нормальный первый прогон' : ''}`)
for (const [source, count] of bySource) console.log(`   из ${source}: ${count}`)
const coarse = journal.filter(
  (snapshot) => snapshot.source === 'oauth' && (snapshot.fiveHour?.pct ?? 0) < CALIBRATION.minIntegerPct,
).length
if (coarse > 0) {
  console.log(`   из них ниже порога ${CALIBRATION.minIntegerPct}% и в систему не идут: ${coarse}`)
}

console.log('\n5. Живой запрос')
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
 * Из Node этот эндпоинт отвечает 403: Cloudflare отсекает его по отпечатку TLS
 * (замер — в брифе, раздел «Ходить обязан Chromium, а не Node»). Проба,
 * ходящая не тем стеком, что приложение, проверяла бы не то, поэтому запрос
 * делает `oauth-ask.cjs` под настоящим Electron, а сюда возвращает одну строку
 * JSON. `ELECTRON_RUN_AS_NODE` снимается явно — под ней Electron стартует
 * обычной нодой, и мы намерили бы ровно то, чего избегаем.
 *
 * Расширение `.cjs` не косметика: проект объявлен `"type": "module"`, а main
 * Electron грузится обычным `require`. Под `.js` он падает на `require is not
 * defined`, но **не выходит**: Electron показывает диалог с ошибкой и ждёт
 * нажатия, которого в фоне никто не сделает, — то есть проба висит до
 * таймаута вместо честного отказа.
 */
async function ask(): Promise<void> {
  const { token } = readToken({ claudeHome, platform: process.platform, fetch: forbidden })
  if (token === undefined) {
    console.log('   ✗ токена нет — авторизуйтесь в Claude Code')
    failed = true
    return
  }

  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const helper = fileURLToPath(new URL('./oauth-ask.cjs', import.meta.url))
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
    console.log('   ответ не 200 — смотрите правила в брифе, раздел «Свежесть и 429»')
    return
  }
  const snapshot = parseOauthUsage(result.body, Date.now())
  if (snapshot === null) {
    console.log('   ✗ ответ 200, но окон с границей в нём нет')
    failed = true
    return
  }
  console.log(`   ${describe(snapshot)}`)
  const integer = [snapshot.fiveHour?.pct, snapshot.weekly?.pct].every(
    (pct) => pct === undefined || Number.isInteger(pct),
  )
  console.log(`   проценты ${integer ? 'целые — порог minIntegerPct в силе' : 'дробные — проверьте порог, источник изменился'}`)
}

function describe(snapshot: UsageSnapshot): string {
  const parts: string[] = []
  if (snapshot.fiveHour) parts.push(`5 ч ${snapshot.fiveHour.pct}% до ${when(snapshot.fiveHour.resetsAt)}`)
  if (snapshot.weekly) parts.push(`7 дней ${snapshot.weekly.pct}% до ${when(snapshot.weekly.resetsAt)}`)
  return parts.join(' · ')
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

function describeCredentials(from: 'file' | 'keychain' | 'missing'): string {
  if (from === 'file') return 'из .credentials.json'
  if (from === 'keychain') return 'из связки ключей'
  return 'не найден'
}

/** Проба сама в сеть не ходит: `readToken` получает `fetch`, который падает. */
function forbidden(): never {
  throw new Error('readToken в сеть не ходит')
}

function join(...parts: string[]): string {
  return parts.join('/')
}
