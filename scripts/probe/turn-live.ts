/**
 * Текущий ход агента на живых логах — этап 6.1.
 *
 *     node --experimental-strip-types scripts/probe/turn-live.ts
 *
 * Семь проверок. Первые четыре меряют разбор на всех транскриптах, какие есть
 * на машине: правило распознавания реплики человека и то, сколько хвоста ему
 * нужно. Остальные три смотрят на живой снимок целиком.
 *
 * Каждая названа по поломке, которую обязана поймать. Числа не зашиты — проба
 * их считает и печатает, потому что на другой машине они другие; зашиты только
 * границы, за которыми правило перестаёт работать.
 */
import { existsSync, mkdtempSync, openSync, closeSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LIVE_OPTIONS,
  createLiveLayer,
  defaultClaudeHome,
  defaultCodexHome,
  ingestAll,
  openDb,
  readPrompt,
  type ClaudeLimits,
  type Provider,
} from '../../packages/core/src/index.ts'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-turn-probe-'))
const claudeHome = defaultClaudeHome()
const codexHome = defaultCodexHome()
const unknownLimits: ClaudeLimits = {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: null,
  plan: null,
}

const TAIL = DEFAULT_LIVE_OPTIONS.tailBytes
const DEEP = DEFAULT_LIVE_OPTIONS.deepTailBytes
/** Сколько свежих файлов брать на провайдера: проба не должна читать весь диск. */
const SAMPLE = 120

const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const claude = freshest(claudeTranscripts(), SAMPLE)
  const codex = freshest(codexRollouts(), SAMPLE)

  // 1. Ловит потерю правила «текст из last-prompt»: в записи `user` слэш-команда
  //    лежит развёрнутой, и под задачей оказался бы `<command-message>`.
  const claudeTail = claude.map((path) => read(path, 'claude', TAIL))
  const withText = claudeTail.filter((read) => read?.text !== undefined).length
  report(
    1,
    'Claude: вопрос находится в обычном хвосте',
    `${withText} из ${claude.length} файлов`,
    claude.length === 0 || withText / claude.length >= 0.8,
  )

  // 2. Ловит обратное допущение — что метка времени лежит там же. Она в другой
  //    записи, и хвоста ей хватает заметно реже: без разделения половин расход
  //    хода считался бы от чужой границы.
  const withAt = claudeTail.filter((read) => read?.at !== undefined).length
  report(
    2,
    'Claude: начало хода находится реже текста',
    `${withAt} из ${claude.length} — на то и разделены половины`,
    claude.length === 0 || withAt <= withText,
  )

  // 3. Ловит «хвоста хватит всем»: у Codex роллаут медианно в 486 КБ, и реплика
  //    человека уезжает из 64 КБ у двух файлов из трёх. Без разового глубокого
  //    дочита живая строка Codex осталась бы без вопроса.
  const codexTail = codex.filter((path) => read(path, 'codex', TAIL)?.text !== undefined).length
  const codexDeep = codex.filter((path) => read(path, 'codex', DEEP)?.text !== undefined).length
  report(
    3,
    'Codex: глубокий дочит находит то, чего нет в хвосте',
    `${codexTail} из ${codex.length} в ${TAIL / 1024} КБ, ${codexDeep} в ${DEEP / 1024} КБ`,
    codex.length === 0 || codexDeep >= codexTail,
  )

  // 4. Ловит вопрос, который не влезет в строку ленты и приедет в окно целиком:
  //    промпт бывает вставленным логом на десятки килобайт.
  const longest = Math.max(
    0,
    ...[...claudeTail, ...codex.map((path) => read(path, 'codex', TAIL))].map(
      (read) => read?.text?.length ?? 0,
    ),
  )
  report(4, 'вопрос обрезан ядром', `самый длинный — ${longest} знаков`, longest <= 201)

  const ingest = ingestAll(db, { claudeHome, codexHome, claudeLimits: unknownLimits })
  const live = createLiveLayer(db, { claudeHome, codexHome, claudeLimits: unknownLimits })
  const snapshot = live.snapshot()
  const working = snapshot.agents.filter((agent) => agent.state !== 'done')

  // 5. Ловит расход хода, посчитанный от старта сессии: он не может быть больше
  //    расхода всей сессии, а равен ей ровно на первом ходе.
  const over = working.filter(
    (agent) => (agent.currentTurn?.spend?.tokens ?? 0) > agent.tokens,
  )
  report(
    5,
    'расход хода не больше расхода сессии',
    over.length === 0 ? `проверено на ${working.length} живых` : over.map((a) => a.sessionId).join(', '),
    over.length === 0,
  )

  // 6. Ловит половину хода, доехавшую без второй: расход обязан приезжать
  //    вместе с меткой, от которой он посчитан, и никогда без неё.
  const orphan = working.filter(
    (agent) => agent.currentTurn?.spend !== undefined && agent.currentTurn.startedAt === undefined,
  )
  report(
    6,
    'расход хода не бывает без его начала',
    orphan.length === 0 ? 'ни одного' : orphan.map((a) => a.sessionId).join(', '),
    orphan.length === 0,
  )

  // 7. Ловит подорожавший опрос: живой слой зовётся раз в секунду, и разовый
  //    глубокий дочит обязан оставаться разовым.
  const started = performance.now()
  for (let i = 0; i < 10; i += 1) live.snapshot()
  const each = (performance.now() - started) / 10
  report(
    7,
    'повторный снимок дёшев',
    `${each.toFixed(1)} мс на опрос при ${working.length} живых и ${ingest.parsed} разобранных файлах`,
    each < 100,
  )

  console.log(
    `\nживых агентов ${working.length}; с вопросом ${working.filter((a) => a.currentTurn?.prompt !== undefined).length}, ` +
      `с началом хода ${working.filter((a) => a.currentTurn?.startedAt !== undefined).length}`,
  )
  for (const agent of working) {
    const turn = agent.currentTurn
    console.log(
      `  ${agent.provider} · ${agent.project} · ${agent.state} · ход ${turn?.spend?.tokens ?? '—'} ` +
        `в ${turn?.spend?.requests ?? '—'} запросах · «${turn?.prompt ?? '—'}»`,
    )
  }
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)

/** Кусок с конца файла, разобранный тем же кодом, что и в живом слое. */
function read(path: string, provider: Provider, bytes: number) {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  const length = Math.min(bytes, size)
  if (length === 0) return undefined
  const buffer = Buffer.allocUnsafe(length)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, size - length)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const all = buffer.toString('utf8').split('\n')
  return readPrompt(provider, length < size ? all.slice(1) : all)
}

function claudeTranscripts(): string[] {
  const root = join(claudeHome, 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const name of readdirSync(join(root, dir.name))) {
      if (name.endsWith('.jsonl')) out.push(join(root, dir.name, name))
    }
  }
  return out
}

function codexRollouts(): string[] {
  const root = join(codexHome, 'sessions')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(root)
  return out
}

/** Самые свежие файлы: разбор ходов интересен там, где ходы недавние. */
function freshest(paths: readonly string[], count: number): string[] {
  return [...paths]
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs }
      } catch {
        return { path, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count)
    .map((entry) => entry.path)
}

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
