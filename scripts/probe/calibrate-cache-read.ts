/**
 * Калибровка веса `cache_read` в подписочном лимите Claude — этап 1.9.
 *
 *     node --experimental-strip-types scripts/probe/calibrate-cache-read.ts snap
 *     node --experimental-strip-types scripts/probe/calibrate-cache-read.ts solve
 *
 * Неизвестных два — вес `w` и потолок плана `C`, — а уравнение одно:
 *
 *     (A + w · R) / C = p
 *
 * где `A = input + output + cacheWrite` и `R = cacheRead` считаем мы, а `p`
 * говорит `/usage`. Поэтому одного снимка мало **принципиально**: любой вес
 * объясняет любой процент подбором потолка. Нужны два замера **одного и того
 * же** окна, разнесённые работой:
 *
 *     (A₁ + w·R₁) / (A₂ + w·R₂) = p₁ / p₂
 *
 * откуда `w = (p₁·A₂ − p₂·A₁) / (p₂·R₁ − p₁·R₂)`, а `C` — из любого из двух.
 *
 * Отсюда же требования к замерам, и нарушать их бессмысленно, а не небрежно:
 *
 * — **одно окно.** Якорь пятичасового окна должен совпасть у обоих снимков,
 *   иначе сравниваются разные счётчики. Скрипт это проверяет и отказывается.
 * — **разница в работе, а не во времени.** Знаменатель `p₂·R₁ − p₁·R₂` тем
 *   ближе к нулю, чем меньше между снимками израсходовано: два одинаковых
 *   замера дают 0/0. Скрипт печатает обусловленность и ругается, если она
 *   плохая.
 * — **процент из `/usage` — целое число.** Клиент округляет, и это главный
 *   источник погрешности. Скрипт считает вес не только по названным
 *   процентам, но и по их границам округления, и печатает разброс: если он
 *   шире здравого смысла, замеры надо разнести сильнее, а не поверить середине.
 *
 * Результат в конфиг руками, вместе с записанным расхождением — этап 1.9
 * существует ради ручной сверки, и автоматизировать его вывод нельзя.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_CONFIG,
  configDir,
  defaultClaudeHome,
  defaultCodexHome,
  ensureLimitWindows,
  ingestAll,
  limitsReport,
  openDb,
  type ClaudeLimits,
} from '../../packages/core/src/index.ts'

const JOURNAL = join(configDir(), 'cache-read-calibration.jsonl')

interface Snap {
  at: number
  /** Якорь пятичасового окна: два снимка одного окна обязаны совпасть здесь. */
  windowStartsAt: number
  resetsAt: number
  /** `input + output + cacheWrite` — то, что считается в лимите наверняка. */
  a: number
  /** `cacheRead` — то, чей вес и ищем. */
  r: number
  requests: number
  /** Процент из `/usage`, вписывается руками. */
  usagePercent?: number
}

const mode = process.argv[2] ?? 'snap'
if (mode === 'snap') snap()
else if (mode === 'solve') solve()
else {
  console.error('режимы: snap | solve')
  process.exit(2)
}

function snap(): void {
  const percentArg = process.argv[3]
  const temp = join(configDir(), 'calibration-index.sqlite')
  mkdirSync(dirname(temp), { recursive: true })
  const { db } = openDb(temp)
  const limits: ClaudeLimits = DEFAULT_CONFIG.limits.claude
  try {
    ingestAll(db, {
      claudeHome: defaultClaudeHome(),
      codexHome: defaultCodexHome(),
      claudeLimits: limits,
    })
    ensureLimitWindows(db, limits)
    const window = limitsReport(db, Date.now(), limits).windows.find(
      (row) => row.provider === 'claude' && row.kind === 'fiveHour',
    )
    if (window === undefined || window.usage === undefined) {
      console.error('текущего пятичасового окна Claude нет — замерять нечего')
      process.exit(1)
    }
    const record: Snap = {
      at: Date.now(),
      windowStartsAt: window.startsAt,
      resetsAt: window.resetsAt,
      a: window.usage.input + window.usage.output + window.usage.cacheWrite,
      r: window.usage.cacheRead,
      requests: window.usage.requests,
    }
    if (percentArg !== undefined) {
      const parsed = Number(percentArg)
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
        console.error(`процент из /usage должен быть числом 0…100, а не «${percentArg}»`)
        process.exit(2)
      }
      record.usagePercent = parsed
    }
    mkdirSync(dirname(JOURNAL), { recursive: true })
    appendFileSync(JOURNAL, `${JSON.stringify(record)}\n`, 'utf8')

    console.log(`снимок записан в ${JOURNAL}`)
    console.log(`  окно      ${new Date(record.windowStartsAt).toLocaleString('ru')} → ${new Date(record.resetsAt).toLocaleString('ru')}`)
    console.log(`  A         ${record.a.toLocaleString('ru')}`)
    console.log(`  cacheRead ${record.r.toLocaleString('ru')}`)
    console.log(`  запросов  ${record.requests}`)
    console.log(
      record.usagePercent === undefined
        ? '  процент   не задан — допишите его в журнал или снимите заново с аргументом'
        : `  /usage    ${record.usagePercent}%`,
    )
  } finally {
    db.close()
  }
}

function solve(): void {
  if (!existsSync(JOURNAL)) {
    console.error(`журнала нет: ${JOURNAL}`)
    process.exit(1)
  }
  const all = readFileSync(JOURNAL, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Snap)
    .filter((snapshot) => snapshot.usagePercent !== undefined)

  const byWindow = new Map<number, Snap[]>()
  for (const snapshot of all) {
    const list = byWindow.get(snapshot.windowStartsAt) ?? []
    list.push(snapshot)
    byWindow.set(snapshot.windowStartsAt, list)
  }

  let solved = false
  for (const [startsAt, list] of byWindow) {
    if (list.length < 2) continue
    list.sort((x, y) => x.at - y.at)
    const first = list[0]!
    const last = list.at(-1)!
    console.log(`\nокно от ${new Date(startsAt).toLocaleString('ru')}, снимков ${list.length}`)
    console.log(
      `  замер 1: ${new Date(first.at).toLocaleTimeString('ru')} A=${first.a} R=${first.r} p=${first.usagePercent}%`,
    )
    console.log(
      `  замер 2: ${new Date(last.at).toLocaleTimeString('ru')} A=${last.a} R=${last.r} p=${last.usagePercent}%`,
    )
    console.log(
      `  между ними: ${Math.round((last.at - first.at) / 60_000)} мин, +${last.a - first.a} A, +${last.r - first.r} cacheRead`,
    )

    // Процент из `/usage` округлён до целого, поэтому вес считается ещё и по
    // углам интервала неопределённости: середина без разброса — это уверенность,
    // которой у нас нет.
    const corners: number[] = []
    for (const d1 of [-0.5, 0, 0.5]) {
      for (const d2 of [-0.5, 0, 0.5]) {
        const w = weight(first, last, first.usagePercent! + d1, last.usagePercent! + d2)
        if (w !== null) corners.push(w)
      }
    }
    if (corners.length === 0) {
      console.log('  ✗ знаменатель нулевой: между замерами почти не жгли, разнесите их сильнее')
      continue
    }
    const exact = weight(first, last, first.usagePercent!, last.usagePercent!)
    const low = Math.min(...corners)
    const high = Math.max(...corners)
    console.log(`  вес cache_read: ${fmt(exact)}  (с учётом округления процента: ${fmt(low)} … ${fmt(high)})`)
    if (exact !== null) {
      const cap = (last.a + exact * last.r) / (last.usagePercent! / 100)
      console.log(`  потолок плана: ${Math.round(cap).toLocaleString('ru')} токенов`)
    }
    if (exact === null || exact < 0 || exact > 1) {
      console.log('  ✗ вес вне [0, 1] — замеры не из одного окна либо процент записан не тот')
    } else if (high - low > 0.15) {
      console.log('  ✗ разброс шире 0.15: замеры слишком близки, нужен ещё один после работы')
    } else {
      console.log('  ✓ годится в конфиг — вписывать руками, вместе с этим разбросом')
      solved = true
    }
  }

  if (!solved) {
    console.log('\nпригодной пары нет: нужны два замера одного пятичасового окна с работой между ними')
    process.exit(1)
  }
}

/** w = (p₁·A₂ − p₂·A₁) / (p₂·R₁ − p₁·R₂) */
function weight(first: Snap, last: Snap, p1: number, p2: number): number | null {
  const denominator = p2 * first.r - p1 * last.r
  if (Math.abs(denominator) < 1e-9) return null
  return (p1 * last.a - p2 * first.a) / denominator
}

function fmt(value: number | null): string {
  return value === null ? '—' : value.toFixed(4)
}
