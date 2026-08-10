/**
 * Пути инструментов на живых логах (3.4).
 *
 *     node --experimental-strip-types scripts/probe/files-live.ts
 *
 * Фикстуры обезличены: в них лежат `lorem ipsum` вместо содержимого и `/proj/e`
 * вместо каталогов. Формат при этом настоящий только там, где его сохранили
 * руками, поэтому разбор входа обязан быть проверен на том, что пишет CLI
 * сегодня, — иначе первая же смена формата патча пройдёт молча, а карточка
 * задачи просто перестанет показывать файлы.
 *
 * Каждая проверка названа поломкой, которую ловит.
 */
import { readFileSync } from 'node:fs'
import {
  changedFiles,
  defaultClaudeHome,
  defaultCodexHome,
  discoverSources,
  ingestAll,
  openDb,
  type Db,
} from '../../packages/core/src/index.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-files-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const started = Date.now()
  const stats = ingestAll(db, { claudeHome: defaultClaudeHome(), codexHome: defaultCodexHome() })
  const files = db.all<{ n: number }>('SELECT count(*) AS n FROM tool_files')[0]?.n ?? 0
  report(
    1,
    'индекс собрался и файлы в нём есть',
    `sources=${stats.parsed} tool_files=${files} за ${((Date.now() - started) / 1000).toFixed(1)} с`,
    stats.parsed > 0 && files > 0,
  )

  // Ловит потерянный `file_path`: у Claude он объявлен параметром, и вызов
  // `Read`/`Edit`/`Write` без строки в tool_files означает, что разбор входа
  // отвалился — при зелёных фикстурах и молча.
  const claudeGap = db.all<{ name: string; calls: number; withPath: number }>(
    `SELECT tool_calls.name AS name, count(*) AS calls,
            sum(CASE WHEN tool_files.path IS NULL THEN 0 ELSE 1 END) AS withPath
       FROM tool_calls
       JOIN sessions ON sessions.id = tool_calls.session_id
       LEFT JOIN tool_files ON tool_files.session_id = tool_calls.session_id
            AND tool_files.seq = tool_calls.seq AND tool_files.idx = tool_calls.idx
      WHERE sessions.provider = 'claude' AND tool_calls.name IN ('Read', 'Edit', 'Write')
      GROUP BY tool_calls.name`,
  )
  const claudeCalls = claudeGap.reduce((sum, row) => sum + row.calls, 0)
  const claudeWith = claudeGap.reduce((sum, row) => sum + row.withPath, 0)
  report(
    2,
    'у Read/Edit/Write путь есть почти всегда',
    claudeGap.map((row) => `${row.name} ${row.withPath}/${row.calls}`).join(' · '),
    claudeCalls > 0 && claudeWith / claudeCalls > 0.99,
  )

  // Ловит смену формата патча: пока он начинается `*** Begin Patch`, каждый
  // вызов даёт хотя бы один файл. Перестанет — здесь появится ноль, а не
  // «просто меньше файлов на экране».
  const patches = db.all<{ calls: number; withPath: number; paths: number }>(
    `SELECT count(*) AS calls,
            sum(CASE WHEN files.n IS NULL THEN 0 ELSE 1 END) AS withPath,
            coalesce(sum(files.n), 0) AS paths
       FROM tool_calls
       LEFT JOIN (SELECT session_id, seq, idx, count(*) AS n FROM tool_files
                   GROUP BY session_id, seq, idx) AS files
            ON files.session_id = tool_calls.session_id
           AND files.seq = tool_calls.seq AND files.idx = tool_calls.idx
      WHERE tool_calls.name = 'apply_patch'`,
  )[0]
  report(
    3,
    'каждый apply_patch отдал файлы',
    `calls=${patches?.calls ?? 0} с файлами=${patches?.withPath ?? 0} путей=${patches?.paths ?? 0}`,
    (patches?.calls ?? 0) > 0 && patches?.calls === patches?.withPath,
  )

  // Ловит путь, оставшийся абсолютным там, где виден проект: карточка задачи
  // рисует их чипами, и `/Users/fost/Projects/...` в чипе не помещается.
  const sessions = db.all<{ id: string; project: string }>(
    `SELECT DISTINCT sessions.id AS id, sessions.project AS project
       FROM sessions JOIN tool_files ON tool_files.session_id = sessions.id
      WHERE tool_files.action = 'write'`,
  )
  let outside = 0
  let total = 0
  const sample: string[] = []
  for (const session of sessions) {
    for (const file of changedFiles(db, session.id)) {
      total += 1
      if (file.path.startsWith('/')) outside += 1
      if (sample.length < 5 && !file.path.startsWith('/')) {
        sample.push(`${session.project}: ${file.path} ×${file.changes}`)
      }
    }
  }
  report(
    4,
    'путь укорочен по каталогу проекта',
    `сессий=${sessions.length} файлов=${total} снаружи=${outside} · ${sample.join(' · ')}`,
    total > 0 && outside / total < 0.2,
  )

  // Ловит расхождение индекса с самим логом: число уникальных путей в правках
  // сессии обязано совпасть с тем, что видно в её файле глазами. Считается по
  // самой дорогой сессии Codex — там патчи и есть.
  const richest = db.all<{ id: string; source_path: string; n: number }>(
    `SELECT sessions.id AS id, sessions.source_path AS source_path, count(*) AS n
       FROM sessions JOIN tool_files ON tool_files.session_id = sessions.id
      WHERE sessions.provider = 'codex' AND tool_files.action = 'write'
      GROUP BY sessions.id ORDER BY n DESC LIMIT 1`,
  )[0]
  if (richest === undefined) {
    report(5, 'сверка с логом', 'ни одной правки Codex в логах', false)
  } else {
    const expected = patchPathsFromLog(richest.source_path)
    const indexed = new Set(rawPaths(db, richest.id))
    const missing = [...expected].filter((path) => !indexed.has(path))
    const extra = [...indexed].filter((path) => !expected.has(path))
    report(
      5,
      'пути сессии совпали с прочитанными из лога глазами',
      `сессия=${richest.id.slice(0, 8)} в логе=${expected.size} в индексе=${indexed.size} потеряно=${missing.length} лишних=${extra.length}`,
      expected.size > 0 && missing.length === 0 && extra.length === 0,
    )
  }
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)

/** Пути прямо из текста лога — независимый от парсера счёт. */
function patchPathsFromLog(path: string): Set<string> {
  const paths = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('apply_patch')) continue
    let record: { payload?: { name?: string; input?: unknown }; name?: string; input?: unknown }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      continue
    }
    const payload = record.payload ?? record
    if (payload.name !== 'apply_patch' || typeof payload.input !== 'string') continue
    for (const patchLine of payload.input.split('\n')) {
      const match = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/.exec(
        patchLine,
      )
      if (match?.[1]) paths.add(match[1])
    }
  }
  return paths
}

function rawPaths(db: Db, sessionId: string): string[] {
  return db
    .all<{ path: string }>(
      "SELECT DISTINCT path FROM tool_files WHERE session_id = ? AND action = 'write'",
      sessionId,
    )
    .map((row) => row.path)
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
