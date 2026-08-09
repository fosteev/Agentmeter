/**
 * Прогон парсера по всем транскриптам на диске — проверка на дрейф формата (1.4).
 *
 *     node --experimental-strip-types scripts/probe/drift-scan.ts [--slow N] [--json]
 *
 * Фикстуры проверяют, что парсер понимает восемь отобранных сессий. Этот скрипт
 * проверяет обратное: что он не падает на всём остальном — семи с лишним сотнях
 * файлов, писанных десятком версий CLI за месяцы. Падение здесь означает, что
 * индекс встанет на первом же незнакомом файле, а пользователь увидит пустой трей.
 *
 * Три вопроса, на которые он отвечает:
 *   1. есть ли файл, который роняет разбор (исключением или пустым результатом);
 *   2. какие типы записей парсер не знает и в каких версиях CLI они появились;
 *   3. где ломаные строки — на хвосте (норма, файл пишется прямо сейчас) или
 *      в середине (уже не норма).
 */
import { globSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { parseSessionFile } from '../../packages/core/src/index.ts'

const ROOT = join(homedir(), '.claude/projects')
const slowMs = Number(process.argv[process.argv.indexOf('--slow') + 1]) || 1500
const asJson = process.argv.includes('--json')

interface Unknown {
  /** Сколько записей этого типа встретилось всего. */
  records: number
  /** В скольких файлах. */
  files: number
  /** Версии CLI, в чьих транскриптах тип попадался. */
  versions: Set<string>
  /** Пример файла — чтобы было куда посмотреть глазами. */
  sample: string
}

/**
 * Транскрипт — либо файл сессии прямо в папке проекта, либо `agent-<id>.jsonl`
 * сабагента на любой глубине под `subagents/` (у воркфлоу это
 * `subagents/workflows/wf_<id>/`). Всё остальное под `projects/` транскриптом
 * не является: рядом с сабагентами воркфлоу лежит `journal.jsonl` со своим
 * словарём записей и без единой цифры расхода. Разбирать его как сессию —
 * значит завести в индексе фантомную сессию без запросов, поэтому такие файлы
 * отсеиваются здесь, а не объявляются дрейфом формата.
 */
function isTranscript(file: string): boolean {
  return basename(dirname(file)).startsWith('-') || basename(file).startsWith('agent-')
}

const unknown = new Map<string, Unknown>()
const crashed: { file: string; error: string }[] = []
const malformed: { file: string; lines: number; atTail: boolean }[] = []
const slow: { file: string; ms: number; mb: number }[] = []
const versions = new Map<string, number>()

const all = globSync(join(ROOT, '**/*.jsonl')).sort()
const files = all.filter(isTranscript)
const skipped = all.filter((file) => !isTranscript(file))
let requests = 0
let sessions = 0
let empty = 0
let bytes = 0
const started = Date.now()

for (const file of files) {
  const size = statSync(file).size
  bytes += size
  const t0 = Date.now()

  let result
  try {
    result = parseSessionFile(file)
  } catch (error) {
    crashed.push({ file, error: error instanceof Error ? error.message : String(error) })
    continue
  }

  const ms = Date.now() - t0
  if (ms > slowMs) slow.push({ file, ms, mb: size / 1024 / 1024 })

  sessions += 1
  requests += result.requests.length
  // Файл разобрался, но ни одного запроса в нём нет. Штатно бывает у только что
  // начатой сессии; массово — признак того, что парсер перестал узнавать `assistant`.
  if (result.requests.length === 0) empty += 1

  for (const version of result.diagnostics.cliVersions) {
    versions.set(version, (versions.get(version) ?? 0) + 1)
  }

  for (const [type, count] of Object.entries(result.diagnostics.unknownRecordTypes)) {
    const entry = unknown.get(type) ?? { records: 0, files: 0, versions: new Set(), sample: file }
    entry.records += count
    entry.files += 1
    for (const version of result.diagnostics.cliVersions) entry.versions.add(version)
    unknown.set(type, entry)
  }

  if (result.diagnostics.malformedLines > 0) {
    malformed.push({
      file,
      lines: result.diagnostics.malformedLines,
      atTail: brokenOnlyAtTail(file),
    })
  }
}

/**
 * Оборванная последняя строка — обычное дело: файл пишется в этот момент.
 * Ломаная строка в середине — уже симптом, её стоит увидеть.
 */
function brokenOnlyAtTail(file: string): boolean {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') continue
    try {
      JSON.parse(line)
    } catch {
      return false
    }
  }
  return true
}

const elapsed = Date.now() - started

if (asJson) {
  console.log(
    JSON.stringify(
      {
        files: files.length,
        skipped: skipped.map((file) => relative(ROOT, file)),
        sessions,
        empty,
        requests,
        crashed,
        malformed,
        slow,
        unknown: Object.fromEntries(
          [...unknown].map(([type, u]) => [
            type,
            { ...u, versions: [...u.versions].sort(), sample: relative(ROOT, u.sample) },
          ]),
        ),
      },
      null,
      2,
    ),
  )
} else {
  const mb = (bytes / 1024 / 1024).toFixed(0)
  console.log(
    `${files.length} транскриптов, ${mb} МБ, ${sessions} сессий (${empty} без запросов), ` +
      `${requests} запросов — ${(elapsed / 1000).toFixed(1)} с`,
  )
  console.log(`не транскрипты, пропущено: ${skipped.length}\n`)

  console.log(`версии CLI: ${[...versions.keys()].sort().join(', ')}\n`)

  if (unknown.size === 0) {
    console.log('незнакомых типов записей нет\n')
  } else {
    console.log(`незнакомые типы записей (${unknown.size}):`)
    const rows = [...unknown].sort((a, b) => b[1].records - a[1].records)
    for (const [type, u] of rows) {
      console.log(
        `  ${type.padEnd(28)} ${String(u.records).padStart(7)} записей  ` +
          `${String(u.files).padStart(4)} файлов  версии: ${[...u.versions].sort().join(', ')}`,
      )
    }
    console.log(`  пример: ${relative(ROOT, rows[0]![1].sample)}\n`)
  }

  const midFile = malformed.filter((m) => !m.atTail)
  console.log(
    `ломаные строки: ${malformed.length} файлов ` +
      `(${malformed.length - midFile.length} только на хвосте, ${midFile.length} в середине)`,
  )
  for (const m of midFile) console.log(`  ! ${relative(ROOT, m.file)} — ${m.lines} строк`)

  if (slow.length) {
    console.log(`\nмедленнее ${slowMs} мс:`)
    for (const s of slow.sort((a, b) => b.ms - a.ms)) {
      console.log(`  ${s.ms.toString().padStart(6)} мс  ${s.mb.toFixed(1).padStart(6)} МБ  ${relative(ROOT, s.file)}`)
    }
  }

  if (crashed.length === 0) {
    console.log('\nни один файл не уронил разбор')
  } else {
    console.log(`\nразбор упал на ${crashed.length} файлах:`)
    for (const c of crashed) console.log(`  ✗ ${relative(ROOT, c.file)} — ${c.error}`)
  }
}

process.exit(crashed.length === 0 ? 0 : 1)
