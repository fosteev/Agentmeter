/**
 * Постоянное против разового (4.1) на всех живых логах.
 *
 *     node --experimental-strip-types scripts/probe/split-live.ts
 *
 * Индекс собирается прямо по настоящим каталогам, без снимка во временный дом:
 * пути файлов памяти (глобальный `CLAUDE.md`, индекс автопамяти) выводятся из
 * дома, и на копии их не оказалось бы — проверка 6 была бы зелена на пустоте.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  PREFIX_BYTES_PER_TOKEN,
  defaultClaudeHome,
  discoverSources,
  ingestAll,
  openDb,
  parseSessionFile,
  spendSplit,
  todayReport,
  type Db,
  type PrefixBlock,
} from '../../packages/core/src/index.ts'
import { claudeMemoryPaths } from '../../packages/core/src/sources/claude/memory.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-split-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const ingest = ingestAll(db)
  const days = daysWithSpend(db)

  const mismatch = db.get<{ count: number }>(
    `SELECT count(*) AS count FROM requests
     WHERE context_tokens + output != input + output + cache_write + cache_read`,
  )!
  const requests = db.get<{ count: number }>('SELECT count(*) AS count FROM requests')!
  report(
    1,
    'тождество суммы',
    `requests=${requests.count} mismatches=${mismatch.count}`,
    requests.count > 0 && mismatch.count === 0 && ingest.failed === 0,
  )

  const splits = days.map((range) => ({ range, split: spendSplit(db, range) }))
  const exact = splits.filter(
    ({ split }) => split.recurring + split.marginal !== split.total,
  ).length
  const headers = splits.filter(
    ({ range, split }) => todayReport(db, range).totals?.total !== split.total,
  ).length
  report(
    2,
    'разложение точное',
    `days=${splits.length} broken=${exact} vsHeader=${headers}`,
    splits.length > 0 && exact === 0 && headers === 0,
  )

  const negative = splits.filter(({ split }) => split.marginal < 0)
  const shares = splits.map(({ split }) => split.recurring / split.total).sort((a, b) => a - b)
  report(
    3,
    'разовое неотрицательно',
    `negative=${negative.length} recurringShare: min=${percent(shares.at(0))} median=${percent(shares[Math.floor(shares.length / 2)])} max=${percent(shares.at(-1))}`,
    negative.length === 0,
  )

  const categories = splits.filter(
    ({ split }) =>
      split.categories.reduce((sum, row) => sum + row.tokens, 0) !== split.recurring,
  ).length
  const kinds = new Set(splits.flatMap(({ split }) => split.categories.map((row) => row.category)))
  report(
    4,
    'категории сходятся',
    `days=${splits.length} broken=${categories} kinds=${kinds.size}`,
    categories === 0 && kinds.size >= 5,
  )

  const scoped = splits.filter(({ range, split }) => {
    const byProvider = (['claude', 'codex'] as const).reduce(
      (sum, provider) => sum + spendSplit(db, range, { provider }).recurring,
      0,
    )
    const byProject = todayReport(db, range).projects.reduce(
      (sum, row) => sum + spendSplit(db, range, { project: row.key }).recurring,
      0,
    )
    return byProvider !== split.recurring || byProject !== split.recurring
  }).length
  report(
    5,
    'сужение доезжает',
    `days=${splits.length} broken=${scoped}`,
    splits.length > 0 && scoped === 0,
  )

  const debt = memoryDebt()
  report(
    6,
    'долг 1.7 закрыт',
    `sessions=${debt.sessions} (без префикса пропущено ${debt.skipped}) файлов ${debt.files} список сошёлся ${debt.listed} tokens=${debt.tokens} (медиана ${debt.median} на сессию) поштучно сошлось ${debt.expected} shifted=${debt.shifted} negative=${debt.negative}`,
    debt.sessions > 0 &&
      debt.files >= 2 &&
      debt.listed === debt.sessions &&
      debt.expected === debt.sessions &&
      debt.shifted === debt.sessions &&
      debt.negative === 0,
  )
  // Для сведения, без порога — как медиана Codex в шестой проверке 1.7.
  //
  // Правильное вычитание сдвигает остаток на константу проекта, а не
  // расшатывает его: разброс p90−p10 обязан остаться прежним. Он и остаётся —
  // до токена в подавляющем большинстве групп. Относительный порог 1.7
  // (разброс к медиане ≤ 10%) при этом слегка проседает, и не потому, что
  // разброс вырос, а потому, что уменьшился знаменатель. Порог не трогаем и
  // число не подгоняем: строка печатается затем, чтобы просадку было видно.
  const groups = residualGroups()
  console.log(
    `  остаток: групп ${groups.length}, разброс не вырос у ${groups.filter((group) => group.after <= group.before).length}, ` +
      `порог 1.7 (≤10% от медианы) проходят ${groups.filter((group) => group.relativeBefore <= 0.1).length} → ${groups.filter((group) => group.relativeAfter <= 0.1).length}`,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exit(1)

/**
 * Дни, в которые был расход, — границы берутся из самого индекса.
 *
 * Календарно и по локальному времени, как везде в продукте: сутки бывают 23 и
 * 25 часов, и фиксированная длина заставила бы соседние дни перекрываться.
 */
function daysWithSpend(db: Db): Array<{ from: number; to: number }> {
  const rows = db.all<{ day: string }>(
    `SELECT DISTINCT date(requests.ts / 1000, 'unixepoch', 'localtime') AS day FROM requests`,
  )
  return rows.map(({ day }) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number]
    const from = new Date(year, month - 1, date).getTime()
    return { from, to: new Date(year, month - 1, date + 1).getTime() }
  })
}

/**
 * Что меняют файлы памяти, которых нет в логе.
 *
 * Один и тот же транскрипт разбирается дважды — со списком путей и без него, —
 * и сравнивается раскладка. Правильный ответ ровно один: `memory` вырос,
 * остаток `system` уменьшился **на ту же величину**, сумма блоков не
 * шелохнулась. Любой другой означает, что мы не переложили байты из одной
 * статьи в другую, а придумали новые.
 *
 * «Стало больше» — не ответ: под него подходит и половина списка, и файл,
 * посчитанный дважды. Поэтому прирост пересчитывается независимо, из размеров
 * самих файлов на диске: цена блока памяти — это `байты / 4.11`, округлённые
 * один раз на весь блок (1.7), значит ожидаемая прибавка равна разнице двух
 * округлений. Мутация «убрать индекс автопамяти из списка» и мутация «считать
 * файл дважды» ловятся именно этим — до него обе проходили молча.
 *
 * Сессии без записанных запросов пропускаются, как и в `prefix-live.ts`:
 * префикс там не измерен вовсе (`prefixTokens = 0`), остаток отрицателен и
 * **до** этого этапа. В дневные числа они не попадают — расхода на них ноль, —
 * но считать их здесь значило бы мерить чужую дыру своей линейкой.
 */
function memoryDebt(): {
  sessions: number
  skipped: number
  files: number
  listed: number
  expected: number
  tokens: number
  median: number
  shifted: number
  negative: number
} {
  const home = defaultClaudeHome()
  const sources = discoverSources().filter(
    (file) => file.provider === 'claude' && file.kind === 'session',
  )
  const seenFiles = new Set<string>()
  let skipped = 0
  let listed = 0
  let expected = 0
  let shifted = 0
  let negative = 0
  const deltas: number[] = []

  for (const file of sources) {
    const before = parseSessionFile(file.path).session
    if (before.prefixTokens === 0) {
      skipped += 1
      continue
    }
    const paths = claudeMemoryPaths(file.path, home)
    if (sameSet(paths, expectedMemoryPaths(file.path, home))) listed += 1
    const after = parseSessionFile(file.path, { memoryPaths: paths }).session
    const memory = tokens(after.prefixBlocks, 'memory') - tokens(before.prefixBlocks, 'memory')
    const residual = tokens(before.prefixBlocks, 'system') - tokens(after.prefixBlocks, 'system')

    let extra = 0
    for (const path of expectedMemoryPaths(file.path, home)) {
      if (!existsSync(path)) continue
      seenFiles.add(path)
      extra += statSync(path).size
    }
    const base = bytes(before.prefixBlocks, 'memory')
    const ratio = PREFIX_BYTES_PER_TOKEN.memory
    if (memory === Math.round((base + extra) / ratio) - Math.round(base / ratio)) expected += 1
    if (memory === residual) shifted += 1
    if (tokens(after.prefixBlocks, 'system') < 0) negative += 1
    deltas.push(memory)
  }

  const sorted = [...deltas].sort((left, right) => left - right)
  return {
    sessions: deltas.length,
    skipped,
    files: seenFiles.size,
    listed,
    expected,
    tokens: deltas.reduce((sum, value) => sum + value, 0),
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    shifted,
    negative,
  }
}

/**
 * Что обязано считаться, — правило, переписанное здесь заново.
 *
 * Именно заново, а не вызовом `claudeMemoryPaths`: проба, спрашивающая
 * проверяемую функцию, чем ей следовало ответить, зелена при любом ответе.
 * Первая версия этой проверки так и была устроена и пропускала мутацию
 * «выкинуть глобальный CLAUDE.md из списка» — обе половины сходились друг с
 * другом на укороченном списке.
 */
function expectedMemoryPaths(sourcePath: string, claudeHome: string): string[] {
  const projects = `${join(claudeHome, 'projects')}${sep}`
  const slug = sourcePath.startsWith(projects)
    ? sourcePath.slice(projects.length).split(sep)[0]
    : undefined
  return [
    join(claudeHome, 'CLAUDE.md'),
    ...(slug ? [join(projects, slug, 'memory', 'MEMORY.md')] : []),
  ]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function bytes(blocks: PrefixBlock[], category: PrefixBlock['category']): number {
  return blocks
    .filter((block) => block.category === category)
    .reduce((sum, block) => sum + block.bytes, 0)
}

/**
 * Разброс остатка внутри группы (версия CLI, модель, проект) — до и после
 * вычитания файлов памяти. Группировка та же, что в четвёртой проверке 1.7.
 */
function residualGroups(): Array<{
  before: number
  after: number
  relativeBefore: number
  relativeAfter: number
}> {
  const home = defaultClaudeHome()
  const groups = new Map<string, Array<{ before: number; after: number }>>()

  for (const file of discoverSources()) {
    if (file.provider !== 'claude' || file.kind !== 'session') continue
    const before = parseSessionFile(file.path).session
    if (before.prefixTokens === 0) continue
    const after = parseSessionFile(file.path, {
      memoryPaths: claudeMemoryPaths(file.path, home),
    }).session
    const key = `${before.cliVersion ?? '?'}\u0000${before.model ?? '?'}\u0000${before.project}`
    groups.set(key, [
      ...(groups.get(key) ?? []),
      { before: residual(before.prefixBlocks), after: residual(after.prefixBlocks) },
    ])
  }

  return [...groups.values()]
    .filter((values) => values.length >= 5)
    .map((values) => {
      const spread = (pick: 'before' | 'after'): number =>
        quantile(values.map((value) => value[pick]), 0.9) -
        quantile(values.map((value) => value[pick]), 0.1)
      const center = (pick: 'before' | 'after'): number =>
        quantile(values.map((value) => value[pick]), 0.5)
      return {
        before: spread('before'),
        after: spread('after'),
        relativeBefore: spread('before') / center('before'),
        relativeAfter: spread('after') / center('after'),
      }
    })
}

function residual(blocks: PrefixBlock[]): number {
  return blocks
    .filter((block) => block.category === 'system' && block.basis === 'residual')
    .reduce((sum, block) => sum + block.tokens, 0)
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  return sorted[lower]! + ((sorted[lower + 1] ?? sorted[lower]!) - sorted[lower]!) * (index - lower)
}

function tokens(blocks: PrefixBlock[], category: PrefixBlock['category']): number {
  return blocks
    .filter((block) => block.category === category)
    .reduce((sum, block) => sum + block.tokens, 0)
}

function percent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
