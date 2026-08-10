/**
 * Из чего состоит задача — на живых логах (3.5).
 *
 *     node --experimental-strip-types scripts/probe/resume-scan.ts
 *
 * Проба отвечает на вопрос, из-за которого этап и существует: сколько файлов в
 * одной задаче. Ответ измерен, а не выбран — resume и `--continue` дописывают
 * продолжение в тот же файл у обоих провайдеров, и склеивать нечего. Модель и
 * счёт контрфакта — в [`docs/roadmap/3.5-tasks.md`](../../docs/roadmap/3.5-tasks.md).
 *
 * Здесь же стоит сторож на будущее: начни провайдер писать ссылку на
 * предыдущую сессию — незнакомым ключом в заголовке Codex или `parentUuid`
 * первой записи Claude, ведущим в другой файл, — проба станет красной, и
 * склейка появится на измеренном признаке, а не на догадке.
 *
 * Каждая проверка названа поломкой, которую ловит.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dayRange,
  DEFAULT_CONFIG,
  defaultClaudeHome,
  defaultCodexHome,
  discoverSources,
  ingestAll,
  openDb,
  taskRows,
  todayReport,
} from '../../packages/core/src/index.ts'

/**
 * Известные ключи заголовка роллаута Codex — все восемнадцать форм, что лежат
 * на диске. Список закрытый нарочно: ссылка на предыдущую сессию, если она
 * когда-нибудь появится, приедет **новым** ключом, и заметить её можно только
 * так. Проба не знает, как этот ключ будет называться, — она знает, каких
 * ключей сегодня нет.
 */
const CODEX_META_KEYS = new Set([
  'id',
  'session_id',
  'timestamp',
  'cwd',
  'originator',
  'cli_version',
  'source',
  'thread_source',
  'model_provider',
  'base_instructions',
  'dynamic_tools',
  'history_mode',
  'context_window',
  'git',
])

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-resume-scan-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const stats = ingestAll(db, { claudeHome: defaultClaudeHome(), codexHome: defaultCodexHome() })
  const sessions = db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')!.n
  report(1, 'индекс собрался', `источников=${stats.parsed} сессий=${sessions}`, sessions > 0)

  // ── Часть первая: resume и --continue ─────────────────────────────────────

  // Ловит вывод «одна сессия — один файл», сделанный из головы: разрыв в
  // несколько суток внутри одного транскрипта ничем, кроме продолжения старой
  // сессии, быть не может. Нет таких разрывов — значит либо логов мало, либо
  // resume поменял поведение, и оба случая требуют пересмотра модели.
  const gaps = db.all<{ provider: string; id: string; gap: number }>(
    `SELECT s.provider, r.session_id AS id, max(r.ts - prev) AS gap FROM (
       SELECT session_id, ts, lag(ts) OVER (PARTITION BY session_id ORDER BY ts) AS prev
         FROM requests) r
     JOIN sessions s ON s.id = r.session_id
     WHERE prev IS NOT NULL GROUP BY r.session_id HAVING gap > 3600000`,
  )
  const resumedClaude = gaps.filter((row) => row.provider === 'claude').length
  const resumedCodex = gaps.filter((row) => row.provider === 'codex').length
  const longest = Math.max(0, ...gaps.map((row) => row.gap)) / 3600000
  report(
    2,
    'resume дописывает в тот же файл — у обоих провайдеров',
    `сессий с разрывом > 1 ч: claude=${resumedClaude} codex=${resumedCodex}, самый долгий ${longest.toFixed(1)} ч`,
    resumedClaude > 0 && resumedCodex > 0,
  )

  // Ловит появление ссылки на предыдущую сессию у Claude — того самого
  // признака, которого сегодня нет. Проверяются оба вида ссылки: общая запись
  // (один `uuid` в двух файлах) и явный родитель первой записи в чужом файле.
  const claudeFiles = discoverSources(defaultClaudeHome(), defaultCodexHome())
    .filter((file) => file.provider === 'claude' && file.kind === 'session')
    .map((file) => file.path)
  const owner = new Map<string, string>()
  const crossParent: string[] = []
  const crossUuid: string[] = []
  const firstParent = new Map<string, string>()
  for (const path of claudeFiles) {
    const text = readFileSync(path, 'utf8')
    for (const [, id] of text.matchAll(/"uuid":"([^"]+)"/g)) {
      const known = owner.get(id!)
      if (known !== undefined && known !== path) crossUuid.push(`${known} ↔ ${path}`)
      else owner.set(id!, path)
    }
    const parent = text.match(/"parentUuid":"([^"]+)"/)
    if (parent) firstParent.set(path, parent[1]!)
  }
  for (const [path, parent] of firstParent) {
    const known = owner.get(parent)
    if (known !== undefined && known !== path) crossParent.push(`${path} → ${known}`)
  }
  report(
    3,
    'у Claude нет ни одной ссылки из файла в файл',
    `транскриптов=${claudeFiles.length} общих записей=${crossUuid.length} чужих родителей=${crossParent.length}`,
    crossUuid.length === 0 && crossParent.length === 0,
  )

  // Ловит новый ключ заголовка Codex. Сегодня их четырнадцать, и ни один не
  // указывает на предшественника; появится пятнадцатый — смотреть на него
  // руками, потому что именно так провайдер и сообщил бы о склейке.
  const codexFiles = discoverSources(defaultClaudeHome(), defaultCodexHome())
    .filter((file) => file.provider === 'codex')
    .map((file) => file.path)
  const unknownKeys = new Set<string>()
  let selfReference = 0
  for (const path of codexFiles) {
    const head = readFileSync(path, 'utf8').split('\n', 1)[0] ?? ''
    let meta: { payload?: Record<string, unknown> }
    try {
      meta = JSON.parse(head) as { payload?: Record<string, unknown> }
    } catch {
      continue
    }
    const payload = meta.payload
    if (payload === undefined) continue
    for (const key of Object.keys(payload)) if (!CODEX_META_KEYS.has(key)) unknownKeys.add(key)
    if (payload['session_id'] !== undefined && payload['session_id'] !== payload['id']) {
      selfReference += 1
    }
  }
  report(
    4,
    'заголовок Codex не ссылается на предыдущий роллаут',
    `роллаутов=${codexFiles.length} незнакомых ключей=${[...unknownKeys].join(',') || 'нет'} session_id ≠ id: ${selfReference}`,
    unknownKeys.size === 0 && selfReference === 0,
  )

  // Ловит соблазн склеить «по соседству». Число печатается всегда: это цена
  // догадки — столько задач исчезло бы из ленты внутрь чужих строк, не имея ни
  // одной записанной связи. Красной проверка становится, если склейка вдруг
  // стала бы безобидной (сосед всего один-два) — тогда довод надо пересчитать.
  const roots = db.all<{ id: string; key: string; started: number; ended: number }>(
    `SELECT id, cwd || '|' || provider AS key, started_at AS started, ended_at AS ended
       FROM sessions WHERE parent_session_id IS NULL ORDER BY key, started_at`,
  )
  let adjacent = 0
  let overlapping = 0
  let pairs = 0
  for (let i = 1; i < roots.length; i++) {
    const left = roots[i - 1]!
    const right = roots[i]!
    if (left.key !== right.key) continue
    const gap = right.started - left.ended
    if (gap >= 0 && gap <= 5 * 60000) adjacent += 1
  }
  const byKey = new Map<string, typeof roots>()
  for (const row of roots) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row])
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        pairs += 1
        if (list[j]!.started < list[i]!.ended) overlapping += 1
      }
    }
  }
  report(
    5,
    'склейка по соседству склеила бы много, а подтверждений нет ни одного',
    `встык ≤ 5 мин: ${adjacent} пар · всего пар в каталоге: ${pairs}, из них внахлёст ${overlapping}`,
    adjacent > 10,
  )

  // ── Часть вторая: сабагенты ───────────────────────────────────────────────

  const days = db
    .all<{ start: number }>(
      `SELECT min(ts) AS start FROM requests
        GROUP BY date(ts / 1000, 'unixepoch', 'localtime') ORDER BY start`,
    )
    .map((row) => dayRange(row.start, DEFAULT_CONFIG.ui.dayStartsAtHour))

  // Ловит дерево, собранное наполовину: расход ребёнка обязан быть внутри
  // строки родителя, а сам ребёнок — в её списке. Проверка не вакуумная, пока
  // на диске есть хоть один сабагент, — и это условие тоже проверяется.
  const folded = days.flatMap((day) => taskRows(db, day))
  const parents = folded.filter((row) => row.children.length > 0)
  const orphans = folded.filter((row) => row.sidechain && row.children.length === 0)
  report(
    6,
    'сабагенты сведены в родителя списком',
    `задач=${folded.length} с детьми=${parents.length} детей=${parents.reduce((sum, row) => sum + row.children.length, 0)} одиноких сайдчейнов=${orphans.length}`,
    parents.length > 0,
  )

  // Ловит двойной счёт — то, ради чего этап и мерился. Сумма ленты обязана
  // сойтись с итогом дня **в обоих** режимах: свернув детей в родителя и
  // разложив их отдельными строками. Разойдись хоть один день — на экране
  // будут два разных числа про одни и те же сутки.
  const wrong: string[] = []
  for (const day of days) {
    const total = todayReport(db, day).totals?.total ?? 0
    const sum = (options: { foldSubagents?: boolean }): number =>
      taskRows(db, day, {}, options).reduce((acc, row) => acc + row.totals.total, 0)
    if (sum({}) !== total) wrong.push(`${new Date(day.from).toISOString().slice(0, 10)}: свёрнуто`)
    if (sum({ foldSubagents: false }) !== total) {
      wrong.push(`${new Date(day.from).toISOString().slice(0, 10)}: развёрнуто`)
    }
  }
  report(
    7,
    'Σ tasks == Σ today на каждом дне и в обоих режимах',
    `дней=${days.length} расхождений=${wrong.length}${wrong[0] ? ` · первое ${wrong[0]}` : ''}`,
    days.length > 0 && wrong.length === 0,
  )

  // Ловит развёрнутый режим, оставивший детей внутри родителя: строк обязано
  // стать ровно на число детей больше, а расход родителя — упасть на их сумму.
  const spread = days.flatMap((day) => taskRows(db, day, {}, { foldSubagents: false }))
  const children = folded.reduce((sum, row) => sum + row.children.length, 0)
  const stillFolded = spread.filter((row) => row.children.length > 0).length
  report(
    8,
    'развёрнутый режим отдаёт детей отдельными строками',
    `строк свёрнуто=${folded.length} развёрнуто=${spread.length} детей=${children} осталось свёрнутыми=${stillFolded}`,
    spread.length === folded.length + children && stillFolded === 0,
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
