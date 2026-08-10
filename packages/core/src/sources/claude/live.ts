import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Entrypoint, LiveSession } from '../types.ts'
import { processState, processStartTimes } from '../../live/process.ts'

type JsonObject = Record<string, unknown>

/**
 * Точка входа в файле сессии написана не так, как в контракте 0.2.
 *
 * На диске лежат `claude-vscode`, `claude-desktop`, `cli` — белый список из
 * `Entrypoint` знает `vscode` и `desktop` без префикса, и потому 8 живых
 * сессий из 9 схлопывались в `unknown`. Незнакомое значение сессию не роняет:
 * агент показывается с `unknown`, а сырая строка уезжает в предупреждения,
 * чтобы дрейф формата было видно, а не только чувствовать.
 */
const ENTRYPOINT_ALIASES: Record<string, Entrypoint> = {
  cli: 'cli',
  'claude-cli': 'cli',
  terminal: 'cli',
  vscode: 'vscode',
  'claude-vscode': 'vscode',
  'vscode-extension': 'vscode',
  jetbrains: 'jetbrains',
  'claude-jetbrains': 'jetbrains',
  desktop: 'desktop',
  'claude-desktop': 'desktop',
  sdk: 'sdk',
  'claude-sdk': 'sdk',
  // Живой список пополняется по мере того, как CLI придумывает новые значения:
  // `sdk-ts` — 6 живых сессий из 20 на момент 2.2, `sdk-cli` — 305 записей в
  // транскриптах. Обе схлопывались в `unknown`, и выглядело это как свойство
  // данных, а не как отставший белый список — та же ошибка, что с
  // `claude-vscode` в 2.1.
  'sdk-ts': 'sdk',
  'sdk-cli': 'sdk',
  exec: 'exec',
  'claude-exec': 'exec',
  unknown: 'unknown',
}

export interface LiveSessionsResult {
  sessions: LiveSession[]
  /** Значения полей, которых мы не знаем, — вход для `doctor`. */
  warnings: string[]
}

/**
 * Уже проверенные pid. Время старта процесса не меняется, пока процесс жив, а
 * на macOS его добывает внешний `ps` — вызывать его каждую секунду опроса ради
 * неизменного числа незачем. Ключ пропадает вместе с процессом.
 */
export type ProcessStartCache = Map<number, number | null>

export function listLiveSessions(dir = defaultSessionsDir()): LiveSession[] {
  return readLiveSessions(dir).sessions
}

/**
 * Живые сессии Claude плюс то, чего мы в их файлах не поняли.
 *
 * Проверок живости две, и вторая не менее важна первой: pid переиспользуется,
 * а файл после падения агента остаётся. Процесс, стартовавший заметно позже,
 * чем написан файл, — не наш, сколько бы он ни отвечал на сигнал 0.
 */
export function readLiveSessions(
  dir = defaultSessionsDir(),
  cache: ProcessStartCache = new Map(),
): LiveSessionsResult {
  if (!existsSync(dir)) return { sessions: [], warnings: [] }

  const warnings: string[] = []
  const candidates: Array<{ session: LiveSession; procStart: number | undefined }> = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { sessions: [], warnings: [] }
  }

  for (const file of entries.filter((name) => name.endsWith('.json')).sort()) {
    const parsed = readLiveSession(join(dir, file), file, warnings)
    if (!parsed) continue
    if (processState(parsed.session.pid) !== 'alive') continue
    candidates.push(parsed)
  }

  const pids = candidates.map((candidate) => candidate.session.pid)
  const unverified = pids.filter((pid) => !cache.has(pid))
  if (unverified.length > 0) {
    const measured = processStartTimes(unverified)
    for (const pid of unverified) cache.set(pid, measured.get(pid) ?? null)
  }
  for (const pid of [...cache.keys()]) {
    if (!pids.includes(pid)) cache.delete(pid)
  }

  const sessions: LiveSession[] = []
  for (const { session, procStart } of candidates) {
    const actual = cache.get(session.pid) ?? undefined
    if (actual !== undefined && !sameProcess(actual, procStart ?? session.startedAt)) {
      warnings.push(`pid ${session.pid} переиспользован: файл сессии старше процесса`)
      continue
    }
    sessions.push(session)
  }

  return { sessions: sessions.sort((a, b) => a.startedAt - b.startedAt), warnings }
}

export function defaultSessionsDir(): string {
  return join(homedir(), '.claude', 'sessions')
}

/** Нормализация точки входа. Экспортируется ради теста, а не ради вызова. */
export function entrypointFromRaw(value: string): Entrypoint | undefined {
  return ENTRYPOINT_ALIASES[value.toLowerCase()]
}

/**
 * Момент из `procStart`, разобранный **как UTC**.
 *
 * Поле выглядит локальным временем (`Mon Aug 10 07:11:48 2026`), а написано в
 * UTC: у процесса, стартовавшего в 10:11:48 по местному времени в зоне +3,
 * стоит ровно 07:11:48. `Date.parse` читает такую строку как локальную и
 * промахивается на смещение зоны — на этой машине на три часа, чего с запасом
 * хватает, чтобы объявить переиспользованным каждый живой pid.
 */
export function parseProcStart(value: string): number | undefined {
  const match = value
    .trim()
    .match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/)
  if (!match) return undefined
  const month = MONTHS.indexOf(match[1]!.toLowerCase())
  if (month < 0) return undefined
  return Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  )
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Файл пишется через доли секунды после старта процесса, но часы источников
// разные, а на Linux время старта восстанавливается из тиков от загрузки.
// Пять минут — запас, которого хватает на эту неточность и не хватает, чтобы
// принять чужой процесс за свой: переиспользование pid случается через часы.
const SAME_PROCESS_MS = 5 * 60 * 1000

function sameProcess(actualStart: number, fileStart: number): boolean {
  return Math.abs(actualStart - fileStart) <= SAME_PROCESS_MS
}

function readLiveSession(
  path: string,
  fileName: string,
  warnings: string[],
): { session: LiveSession; procStart: number | undefined } | undefined {
  try {
    const raw = asObject(JSON.parse(readFileSync(path, 'utf8')))
    if (!raw) return undefined
    const pid = numberField(raw, 'pid') ?? pidFromFile(fileName)
    const sessionId = stringField(raw, 'sessionId') ?? stringField(raw, 'session_id')
    const cwd = stringField(raw, 'cwd')
    const startedAt = timestampField(raw, 'startedAt') ?? timestampField(raw, 'started_at')
    if (pid === undefined || !sessionId || !cwd || startedAt === undefined) return undefined

    const session: LiveSession = {
      pid,
      sessionId,
      provider: 'claude',
      cwd,
      startedAt,
      entrypoint: entrypointField(raw, 'entrypoint', warnings),
    }
    const cliVersion = stringField(raw, 'cliVersion') ?? stringField(raw, 'version')
    const name = stringField(raw, 'name')
    if (cliVersion !== undefined) session.cliVersion = cliVersion
    if (name !== undefined) session.name = name

    const procStartRaw = stringField(raw, 'procStart')
    const procStart = procStartRaw === undefined ? undefined : parseProcStart(procStartRaw)
    return { session, procStart }
  } catch {
    return undefined
  }
}

function pidFromFile(fileName: string): number | undefined {
  const raw = Number.parseInt(fileName.replace(/\.json$/, ''), 10)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined
}

function timestampField(object: JsonObject, key: string): number | undefined {
  const value = object[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function entrypointField(object: JsonObject, key: string, warnings: string[]): Entrypoint {
  const value = stringField(object, key)
  if (value === undefined || value === '') return 'unknown'
  const known = entrypointFromRaw(value)
  if (known !== undefined) return known
  warnings.push(`неизвестная точка входа: ${value}`)
  return 'unknown'
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}
