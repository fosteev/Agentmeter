/**
 * Прогон парсера Codex по всем роллаутам на диске (1.2 + 1.4 со стороны Codex).
 *
 *     node --experimental-strip-types scripts/probe/codex-live.ts [--json]
 *
 * У формата Codex есть встроенная сверка, какой у Claude нет и близко: рядом с
 * расходом каждого запроса лежит накопительный итог сессии. Сумма разобранных
 * запросов обязана сойтись с последним `total_token_usage` **до токена** — иначе
 * запрос либо потерян, либо посчитан дважды. Здесь эта сверка гоняется не на
 * одной фикстуре, а на всём, что накопилось на диске.
 *
 * Заодно тот же вопрос, что и `drift-scan.ts` задаёт транскриптам Claude:
 * какие типы записей парсер не знает и в каких версиях CLI они появились.
 */
import { globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { parseRolloutFile, readLimits } from '../../packages/core/src/index.ts'

const ROOT = join(homedir(), '.codex/sessions')
const asJson = process.argv.includes('--json')

interface Usage {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

/** Последний накопительный итог в файле — эталон, с которым сверяется сумма. */
function lastTotalUsage(path: string): Usage | undefined {
  let last: Usage | undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '' || !line.includes('total_token_usage')) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const payload = (record as { payload?: { info?: { total_token_usage?: Usage } } }).payload
    const usage = payload?.info?.total_token_usage
    if (usage) last = usage
  }
  return last
}

const files = globSync(join(ROOT, '**/rollout-*.jsonl')).sort()

const unknown = new Map<string, { records: number; files: number; versions: Set<string>; sample: string }>()
const crashed: { file: string; error: string }[] = []
const mismatched: { file: string; field: string; parsed: number; expected: number; delta: number }[] = []
const versions = new Map<string, number>()

let checked = 0
let exact = 0
let noUsage = 0
let malformed = 0
let requests = 0
let limits = 0
const started = Date.now()

for (const file of files) {
  let result
  try {
    result = parseRolloutFile(file)
    limits += readLimits(file).length
  } catch (error) {
    crashed.push({ file, error: error instanceof Error ? error.message : String(error) })
    continue
  }

  requests += result.requests.length
  malformed += result.diagnostics.malformedLines
  for (const version of result.diagnostics.cliVersions) versions.set(version, (versions.get(version) ?? 0) + 1)
  for (const [type, count] of Object.entries(result.diagnostics.unknownRecordTypes)) {
    const entry = unknown.get(type) ?? { records: 0, files: 0, versions: new Set<string>(), sample: file }
    entry.records += count
    entry.files += 1
    for (const version of result.diagnostics.cliVersions) entry.versions.add(version)
    unknown.set(type, entry)
  }

  const expected = lastTotalUsage(file)
  if (!expected || result.requests.length === 0) {
    noUsage += 1
    continue
  }

  const totals = result.requests.reduce(
    (acc, request) => ({
      input: acc.input + request.input + request.cacheRead,
      output: acc.output + request.output,
      reasoning: acc.reasoning + (request.reasoning ?? 0),
      cacheRead: acc.cacheRead + request.cacheRead,
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
  )

  checked += 1
  const diffs = [
    { field: 'input', parsed: totals.input, expected: expected.input_tokens },
    { field: 'output', parsed: totals.output, expected: expected.output_tokens },
    { field: 'cached', parsed: totals.cacheRead, expected: expected.cached_input_tokens },
    { field: 'reasoning', parsed: totals.reasoning, expected: expected.reasoning_output_tokens },
  ].filter((d) => d.parsed !== d.expected)

  if (diffs.length === 0) exact += 1
  else for (const d of diffs) mismatched.push({ file, ...d, delta: d.parsed - d.expected })
}

const elapsed = Date.now() - started

if (asJson) {
  console.log(
    JSON.stringify(
      {
        files: files.length,
        checked,
        exact,
        noUsage,
        requests,
        limits,
        crashed,
        mismatched: mismatched.map((m) => ({ ...m, file: relative(ROOT, m.file) })),
        unknown: Object.fromEntries(
          [...unknown].map(([type, u]) => [type, { ...u, versions: [...u.versions].sort(), sample: relative(ROOT, u.sample) }]),
        ),
      },
      null,
      2,
    ),
  )
} else {
  console.log(
    `${files.length} роллаутов, ${requests} запросов, ${limits} наблюдений лимита — ${(elapsed / 1000).toFixed(1)} с`,
  )
  console.log(`сверено с total_token_usage: ${checked}, сошлось до токена: ${exact}, без расхода: ${noUsage}`)
  console.log(`ломаных строк: ${malformed}`)
  console.log(`\nверсии CLI: ${[...versions.keys()].sort().join(', ')}\n`)

  if (unknown.size === 0) {
    console.log('незнакомых типов записей нет\n')
  } else {
    console.log(`незнакомые типы записей (${unknown.size}):`)
    for (const [type, u] of [...unknown].sort((a, b) => b[1].records - a[1].records)) {
      console.log(
        `  ${type.padEnd(34)} ${String(u.records).padStart(7)} записей  ${String(u.files).padStart(4)} файлов  ` +
          `версии: ${[...u.versions].sort().join(', ')}`,
      )
    }
    console.log()
  }

  if (mismatched.length === 0) {
    console.log('сумма запросов сходится с накопительным итогом во всех сессиях')
  } else {
    const byFile = new Set(mismatched.map((m) => m.file))
    console.log(`расхождения в ${byFile.size} сессиях:`)
    for (const m of mismatched.slice(0, 20)) {
      console.log(
        `  ${m.field.padEnd(9)} ${String(m.parsed).padStart(10)} против ${String(m.expected).padStart(10)} ` +
          `(${m.delta > 0 ? '+' : ''}${m.delta})  ${relative(ROOT, m.file)}`,
      )
    }
    if (mismatched.length > 20) console.log(`  … ещё ${mismatched.length - 20}`)
  }

  if (crashed.length > 0) {
    console.log(`\nразбор упал на ${crashed.length} файлах:`)
    for (const c of crashed.slice(0, 10)) console.log(`  ✗ ${relative(ROOT, c.file)} — ${c.error}`)
  } else {
    console.log('\nни один роллаут не уронил разбор')
  }
}

process.exit(crashed.length === 0 && mismatched.length === 0 ? 0 : 1)
