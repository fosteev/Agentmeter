/**
 * Состояния агента и темп на живых логах — этапы 2.2 и 2.3.
 *
 *     node --experimental-strip-types scripts/probe/states-live.ts
 *
 * Восемь проверок. Каждая названа по поломке, которую обязана поймать, и
 * каждая показана красной мутацией кода — проверку, которую не видели красной,
 * считать несуществующей.
 *
 * Хвост читается тем же кодом, что и в живом слое (`readTurn`), но здесь по
 * всем файлам на диске, а не по девяти живым: правило про «чей ход» должно
 * держаться на всём, что провайдеры когда-либо писали, включая 60 версий CLI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  claudeTurn,
  codexTurn,
  defaultClaudeHome,
  defaultCodexHome,
  deriveState,
  ensureLimitWindows,
  ingestAll,
  limitsReport,
  openDb,
  perMinute,
  readLimitWindows,
  type ClaudeLimits,
  type TurnKind,
} from '../../packages/core/src/index.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-states-probe-'))
const claudeHome = defaultClaudeHome()
const codexHome = defaultCodexHome()
const unknownLimits: ClaudeLimits = {
  fiveHourCap: null,
  weeklyCap: null,
  cacheReadWeight: null,
  plan: null,
}
const TAIL_BYTES = 64 * 1024
const tails = new Map<string, string[]>()

/** Учётные записи Claude — те, что ложатся в лог после значимой. */
const BOOKKEEPING = new Set([
  'attachment',
  'file-history-snapshot',
  'file-history-delta',
  'last-prompt',
  'ai-title',
  'custom-title',
  'mode',
  'permission-mode',
  'queue-operation',
  'system',
  'summary',
])

const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const claudeFiles = transcripts(join(claudeHome, 'projects'))
  const codexFiles = rollouts(join(codexHome, 'sessions'))

  // ── 2.2 ────────────────────────────────────────────────────────────────────

  const claudeTurns = claudeFiles.map((path) => ({ path, turn: claudeTurn(tail(path)) }))
  const seen = new Map<TurnKind | 'нет', number>()
  for (const { turn } of claudeTurns) {
    const key = turn?.kind ?? 'нет'
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  // 1. Ловит неверно прочитанного владельца хода — в том числе `tool_use`,
  //    принятый за конец ответа: тогда каждый работающий агент зовёт человека к
  //    машине. Проверка единственная здесь, которая сверяется не с собой:
  //    предсказание проверяется тем, что источник записал **следующим**. Если
  //    ход у человека, дальше в логе обязана быть его реплика; если у агента —
  //    ответ модели либо результат инструмента. Ничего из этого разбор хода не
  //    видит: он смотрит только назад.
  const verdict = predictionCheck(claudeFiles)
  report(
    1,
    'владелец хода подтверждается следующей записью лога',
    `проверок=${verdict.total} (ход у человека=${verdict.humanTurns}, у агента=${verdict.total - verdict.humanTurns}) ошибок=${verdict.wrong}; по хвостам файлов: ${[...seen].map(([k, v]) => `${k}=${v}`).join(' ')}`,
    verdict.humanTurns > 100 && verdict.total - verdict.humanTurns > 500 && verdict.wrong === 0,
  )

  // 2. Ловит возврат к правилу 2.1 «берём тип последней записи»: после значимой
  //    записи в лог ложатся учётные, и по ним состояние неопределимо. Проверка
  //    требует, чтобы такие файлы были в данных (иначе она ничего не стережёт)
  //    и чтобы ход у них всё равно читался.
  const masked = claudeFiles.filter((path) => {
    const kind = lastRecordType(tail(path))
    return kind !== undefined && BOOKKEEPING.has(kind)
  })
  const maskedUnread = masked.filter((path) => claudeTurn(tail(path)) === undefined)
  report(
    2,
    'учётные записи не маскируют ход',
    `последняя запись учётная у ${masked.length} из ${claudeFiles.length}, ход не прочитан у ${maskedUnread.length}`,
    masked.length > 0 && maskedUnread.length === 0,
  )

  // 3. Ловит потерю хвоста: если ход не читается у заметной доли файлов,
  //    состояние молча откатывается к правилу 2.1, и 2.2 существует только на
  //    бумаге. Порог — 5%: обрезанный посередине огромный результат инструмента
  //    в 64 КБ не помещается, и это нормально, а десятки процентов — нет.
  const unread = claudeTurns.filter(({ turn }) => turn === undefined).length
  const unreadShare = claudeFiles.length === 0 ? 1 : unread / claudeFiles.length
  report(
    3,
    'хвоста хватает почти всегда',
    `не прочитан у ${unread} из ${claudeFiles.length} (${(unreadShare * 100).toFixed(1)}%) при ${TAIL_BYTES / 1024} КБ хвоста`,
    unreadShare < 0.05,
  )

  // 4. Ловит перенос правил Claude на Codex. У Codex ход размечен провайдером
  //    (`task_started`/`task_complete`), и проверка требует, чтобы разбор шёл
  //    именно по ним: файлы обоих исходов обязаны найтись, а роллаут,
  //    кончающийся `task_complete`, обязан давать конец хода.
  const codexTurns = codexFiles.map((path) => ({ path, turn: codexTurn(tail(path)) }))
  const codexEnded = codexTurns.filter(({ turn }) => turn?.kind === 'turn-end').length
  const codexBusy = codexTurns.filter(({ turn }) => turn?.kind === 'agent-thinking').length
  const completeTailed = codexFiles.filter((path) => lastEventPayload(tail(path)) === 'task_complete')
  const completeMisread = completeTailed.filter((path) => codexTurn(tail(path))?.kind !== 'turn-end')
  report(
    4,
    'ход Codex читается из разметки провайдера',
    `роллаутов=${codexFiles.length} конец=${codexEnded} в работе=${codexBusy}; кончаются task_complete=${completeTailed.length}, из них неверно=${completeMisread.length}`,
    codexEnded > 0 && completeTailed.length > 0 && completeMisread.length === 0,
  )

  // 5. Ловит «ждёт ответа → простой по таймауту». Законченный ход не протухает
  //    от тишины: агент ждёт человека и через три часа. Проверка берёт реальные
  //    файлы с законченным ходом и заведомо протухшей тишиной — если хоть один
  //    из них выпадает в `idle`, попап перестаёт звать человека ровно тогда,
  //    когда его надо позвать.
  const stale = claudeTurns
    .filter(({ turn }) => turn?.kind === 'turn-end')
    .map(({ path, turn }) => ({
      path,
      state: deriveState({
        at: Date.now(),
        lastActivityAt: statSync(path).mtimeMs,
        idleMs: 90_000,
        turn: turn!.kind,
        alive: true,
      }),
      silentMs: Date.now() - statSync(path).mtimeMs,
    }))
    .filter((row) => row.silentMs > 90_000)
  report(
    5,
    'законченный ход не протухает от тишины',
    `молчащих дольше порога=${stale.length}, из них ушли в простой=${stale.filter((r) => r.state !== 'waiting').length}`,
    stale.length > 0 && stale.every((row) => row.state === 'waiting'),
  )

  // 6. Ловит подмену родителя сабагентом. Записи сайдчейна ведут себя как
  //    обычные — с `end_turn` в конце, — и если разбор их не отличает,
  //    работающий сабагент объявляет родителя ждущим человека, то есть зовёт к
  //    машине, у которой всё идёт. Проверка берёт настоящие транскрипты
  //    сабагентов с диска (в главных файлах таких записей больше не пишут) и
  //    требует, чтобы ход по ним не читался вовсе, а без пометки — читался.
  //    Второе условие обязательно: без него правило «ничего не понимать» тоже
  //    зелёное.
  const subagentFiles = subagents(join(claudeHome, 'projects'))
  const leaking = subagentFiles.filter((path) => claudeTurn(tail(path)) !== undefined)
  const inertWithoutMark = subagentFiles.filter(
    (path) => claudeTurn(tail(path).map(stripSidechainMark)) === undefined,
  )
  report(
    6,
    'сайдчейн не выдаёт себя за ход родителя',
    `транскриптов сабагентов=${subagentFiles.length}, ход прочитан=${leaking.length}, без пометки не читается=${inertWithoutMark.length}`,
    subagentFiles.length > 0 && leaking.length === 0 && inertWithoutMark.length === 0,
  )

  // ── 2.3 ────────────────────────────────────────────────────────────────────

  ingestAll(db, { claudeHome, codexHome, claudeLimits: unknownLimits })
  ensureLimitWindows(db, unknownLimits)

  // 7. Ловит знаменатель темпа: сумма «токенов в минуту» за час обязана сойтись
  //    с прямым подсчётом токенов за тот же час. Деление на окно вместо
  //    прожитого времени, потерянный множитель 60 000 и двойной учёт сабагентов
  //    все ломают именно это тождество.
  const hourAgo = Date.now() - 3_600_000
  const direct = db.get<{ tokens: number | null }>(
    `SELECT sum(input + output + cache_write + cache_read) AS tokens FROM requests WHERE ts >= ?`,
    hourAgo,
  )!.tokens ?? 0
  const viaRate = perMinute(direct, 3_600_000) * 60
  const rateDrift = direct === 0 ? 0 : Math.abs(viaRate - direct) / direct
  report(
    7,
    'темп обратим в токены',
    `за час=${direct} через темп=${viaRate} расхождение=${(rateDrift * 100).toFixed(3)}%`,
    direct > 0 && rateDrift < 0.001,
  )

  // 8. Ловит прогноз, посчитанный из воздуха, и прогноз, посчитанный наоборот.
  //    Пока вес `cache_read` не откалиброван (1.9), у Claude процента нет —
  //    значит и прогноза быть не должно ни одного. Там же, где процент есть
  //    (Codex), время до упора обязано падать с ростом темпа: обратная
  //    зависимость означает перевёрнутое деление.
  const config = structuredClone(DEFAULT_CONFIG)
  // Момент опроса — не «сейчас», а конец последнего окна Codex, где реально
  // жгли: прогноз без расхода в хвостовом окне нулевой у всех, и проверка на
  // простаивающей машине не стерегла бы ничего.
  const busiest = readLimitWindows(db)
    .filter((window) => window.provider === 'codex' && (window.usedPercent ?? 0) > 0)
    .sort((a, b) => b.observedAt - a.observedAt)[0]
  const now = busiest === undefined ? Date.now() : Math.min(busiest.observedAt + 60_000, busiest.resetsAt - 1)
  const fast = limitsReport(db, now, config.limits.claude, 300_000)
  const slow = limitsReport(db, now, config.limits.claude, 1_800_000)
  const claudeForecasts = fast.windows.filter(
    (window) => window.provider === 'claude' && window.forecast !== null,
  ).length
  const pairs = fast.windows
    .map((window) => ({
      window,
      slow: slow.windows.find(
        (other) => other.provider === window.provider && other.startsAt === window.startsAt,
      ),
    }))
    .filter(
      (pair) =>
        (pair.window.forecast?.minutesToCap ?? null) !== null &&
        (pair.slow?.forecast?.minutesToCap ?? null) !== null,
    )
  // Связь обратная: больше темп — меньше времени до упора. Проверяется знаком
  // произведения разностей, а не «у короткого окна темп выше»: какое из двух
  // окон усреднения окажется быстрее, зависит от того, когда жгли, и порядок
  // тут не задан. На живых данных короткое окно как раз медленнее длинного.
  const wrongDirection = pairs.filter((pair) => {
    const dRate = pair.window.forecast!.tokensPerMinute - pair.slow!.forecast!.tokensPerMinute
    const dTime = pair.window.forecast!.minutesToCap! - pair.slow!.forecast!.minutesToCap!
    return dRate * dTime > 0
  }).length
  report(
    8,
    'прогноз есть только там, где есть процент, и растёт в нужную сторону',
    `окон=${fast.windows.length} прогнозов Claude=${claudeForecasts} сравнимых пар=${pairs.length} перевёрнутых=${wrongDirection}`,
    claudeForecasts === 0 && pairs.length > 0 && wrongDirection === 0,
  )
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)


/** Хвост файла теми же 64 КБ, что читает живой слой. */
function tail(path: string): string[] {
  const cached = tails.get(path)
  if (cached !== undefined) return cached
  let lines: string[] = []
  try {
    const size = statSync(path).size
    const buffer = readFileSync(path)
    const from = Math.max(0, size - TAIL_BYTES)
    const all = buffer.subarray(from).toString('utf8').split('\n')
    lines = from > 0 ? all.slice(1) : all
  } catch {
    lines = []
  }
  tails.set(path, lines)
  return lines
}

/**
 * Сверка предсказания с тем, что источник записал следующим.
 *
 * По каждому файлу берутся все места, где значимая запись сменяется значимой.
 * Ход читается по префиксу (то есть только по прошлому), а проверяется по
 * будущему: после конца хода в логе обязана лежать реплика человека —
 * `user` **без** `toolUseResult`, — а после хода агента либо ответ модели,
 * либо результат инструмента.
 *
 * `ask-pending` из сверки исключён сознательно: человек отвечает на вопрос
 * инструментом, и в логе это тот же `toolUseResult`. Разница между «спросил» и
 * «работает» в записях не видна вовсе — она в имени инструмента, и проверить
 * её этим способом нечем.
 */
function predictionCheck(files: readonly string[]): {
  total: number
  wrong: number
  humanTurns: number
} {
  let total = 0
  let wrong = 0
  let humanTurns = 0

  for (const path of files) {
    const all = tail(path)
    const significant: Array<{ index: number; record: Record<string, unknown> }> = []
    for (let i = 0; i < all.length; i += 1) {
      const record = parse(all[i])
      if (record === undefined) continue
      const type = record['type']
      if (type !== 'assistant' && type !== 'user') continue
      if (record['isSidechain'] === true) continue
      if (type === 'user' && record['isMeta'] === true) continue
      significant.push({ index: i, record })
    }

    for (let k = 0; k + 1 < significant.length; k += 1) {
      const here = significant[k]!
      const next = significant[k + 1]!.record
      // Один ответ API пишется несколькими записями `assistant` с общим
      // `requestId` (правило 3 в CLAUDE.md), и `stop_reason` стоит на каждой.
      // Обрывать префикс внутри ответа нельзя: ход там ещё не кончился, и
      // «дальше опять модель» — не ошибка предсказания, а его неверная точка.
      if (
        here.record['requestId'] !== undefined &&
        here.record['requestId'] === next['requestId']
      ) {
        continue
      }
      // Человек может забрать ход в любой момент, и лог этого заранее не
      // объявляет. Прерывание — единственное событие, которое из прошлого
      // принципиально не выводится, поэтому оно из сверки исключено, а не
      // засчитано разбору в ошибку.
      if (interrupted(next) || interrupted(here.record)) continue
      // Синтетические записи пишет сам CLI, а не модель: на диске их 17, и все
      // до одной — `stop_sequence` («Credit balance is too low», «No response
      // requested.»). Предсказывать по ним, что скажет модель, не о чем: она
      // тут вообще не отвечала.
      if (synthetic(next) || synthetic(here.record)) continue

      const turn = claudeTurn(all.slice(0, here.index + 1))
      if (turn === undefined || turn.kind === 'ask-pending') continue

      const humanReplied = next['type'] === 'user' && next['toolUseResult'] === undefined
      if (turn.kind === 'turn-end') {
        total += 1
        humanTurns += 1
        if (!humanReplied) wrong += 1
        continue
      }

      // Обратное направление проверяется только там, где ход у агента был на
      // самом деле: после ответа модели или результата инструмента. Если
      // предыдущая запись — реплика человека, то следующая его же реплика
      // означает, что он написал дважды подряд (очередь сообщений, слэш-команда
      // и следом текст) — 14 таких мест на диске. Человека предсказать нельзя,
      // и записывать это разбору в ошибку значит требовать от него ясновидения.
      const agentHadBall =
        here.record['type'] === 'assistant' || here.record['toolUseResult'] !== undefined
      if (!agentHadBall) continue
      total += 1
      if (humanReplied) wrong += 1
    }
  }
  return { total, wrong, humanTurns }
}

/** Запись, которую сочинил сам CLI, а не модель. */
function synthetic(record: Record<string, unknown>): boolean {
  const message = record['message'] as Record<string, unknown> | undefined
  return message?.['model'] === '<synthetic>' || record['isApiErrorMessage'] === true
}

/** Запись, которой человек оборвал ход: прерывание либо отменённая команда. */
function interrupted(record: Record<string, unknown>): boolean {
  const content = (record['message'] as Record<string, unknown> | undefined)?.['content']
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              typeof (block as Record<string, unknown>)['text'] === 'string'
                ? ((block as Record<string, unknown>)['text'] as string)
                : '',
            )
            .join(' ')
        : ''
  return text.includes('[Request interrupted') || text.includes('<local-command-stdout>')
}

function lastRecordType(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parse(lines[i])
    const type = record?.['type']
    if (typeof type === 'string') return type
  }
  return undefined
}

function lastEventPayload(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parse(lines[i])
    if (record?.['type'] !== 'event_msg') continue
    const payload = record['payload']
    if (typeof payload !== 'object' || payload === null) continue
    const kind = (payload as Record<string, unknown>)['type']
    if (typeof kind === 'string') return kind
  }
  return undefined
}

/** Тот же файл без пометки сайдчейна — вход для проверки 6. */
function stripSidechainMark(line: string): string {
  const record = parse(line)
  if (record === undefined || record['isSidechain'] !== true) return line
  return JSON.stringify({ ...record, isSidechain: false })
}

function parse(line: string | undefined): Record<string, unknown> | undefined {
  const trimmed = line?.trim()
  if (!trimmed) return undefined
  try {
    const raw: unknown = JSON.parse(trimmed)
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function transcripts(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of readdirSync(join(root, entry.name))) {
      if (name.endsWith('.jsonl')) out.push(join(root, entry.name, name))
    }
  }
  return out
}

/**
 * Транскрипты сабагентов: `<проект>/<сессия>/subagents/agent-*.jsonl`, у
 * воркфлоу — уровнем глубже. Отбор по префиксу `agent-`: рядом лежит
 * `journal.jsonl`, и он не транскрипт.
 */
function subagents(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(root, 0)
  return out
}

function rollouts(root: string): string[] {
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

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
