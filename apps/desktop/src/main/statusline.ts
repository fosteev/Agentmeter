/**
 * Хук строки состояния Claude Code: установка, журнал наблюдений, калибровка (1.9).
 *
 * Претензия этапа одна: у Claude в логах нет ни процента лимита, ни потолка
 * окна, ни веса чтения кэша — а всё это лежит в JSON, который Claude Code сам
 * подаёт на stdin команде `statusLine`. Приложение ставит туда свой хук, хук
 * кладёт полученное на диск, приложение дочитывает и решает по нему линейную
 * систему. Сети в этой цепочке нет ни на одном шаге.
 *
 * **Установлен или нет — спрашивается у файла, а не у нашей памяти.** Ровно как
 * автозапуск (`startup.ts`): запись живёт в `~/.claude/settings.json`, человек
 * вправе убрать её оттуда руками, и наша копия ответа разошлась бы с правдой
 * молча. В конфиге лежит только то, чего в файле нет и после нашей записи не
 * будет, — прежнее значение `statusLine`.
 *
 * **Чужая настройка не теряется.** `statusLine` может быть занят, и тогда
 * прежнее значение сохраняется дословным JSON, команда из него вызывается
 * хуком, а снятие возвращает ровно то, что было. Ставить без явного согласия
 * человека нельзя — это правка чужого файла настроек, и решение принимает окно,
 * а не приложение при старте.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  appendUsageJournal,
  calibrate,
  parseStatusLine,
  readClaudeRequests,
  readUsageJournal,
  t,
  usageKeys,
  type Calibration,
  type Db,
  type UsageSnapshot,
} from '@agentmeter/core'
import type { UsageHookStatus } from '@agentmeter/ipc'
import { HOOK_VERSION, hookBody, hookFileName } from './statusline-hook.ts'

/** Что модулю нужно от машины. Не `app` и не конфиг целиком — три пути. */
export interface StatuslineHost {
  /** Каталог настроек Claude Code: там `settings.json`. */
  claudeHome: string
  /** Каталог настроек Agentmeter: там хук, снимок и журнал. */
  configDir: string
  /**
   * Платформа приезжает параметром, а не читается из `process`, по той же
   * причине, что у автозапуска: ветка Windows иначе проверялась бы только на
   * Windows, то есть у меня никогда.
   */
  platform: NodeJS.Platform
}

export function hookPath(host: StatuslineHost): string {
  return join(host.configDir, hookFileName(host.platform))
}

/** Куда хук кладёт команду, стоявшую в строке состояния до нас. */
export function chainPath(host: StatuslineHost): string {
  return join(host.configDir, 'statusline-prev')
}

export function claudeSettingsPath(host: StatuslineHost): string {
  return join(host.claudeHome, 'settings.json')
}

export function latestPath(host: StatuslineHost): string {
  return join(host.configDir, 'usage-latest.json')
}

export function journalPath(host: StatuslineHost): string {
  return join(host.configDir, 'usage.jsonl')
}

/** Что стоит в `statusLine` прямо сейчас — прочитано у файла Claude Code. */
export interface HookState {
  installed: boolean
  /** Чужая команда, которую хук вызывает и не теряет. */
  chained?: string
  /** Файла настроек Claude Code нет или он не разбирается. */
  problem?: string
}

export function readHook(host: StatuslineHost): HookState {
  const settings = readSettings(host)
  if (settings.problem !== undefined) return { installed: false, problem: settings.problem }
  const current = settings.data?.['statusLine']
  const command = commandOf(current)
  if (command === hookPath(host)) {
    const chained = readChain(host)
    return chained === undefined ? { installed: true } : { installed: true, chained }
  }
  return { installed: false }
}

export interface InstallResult {
  /**
   * Что стояло в `statusLine` до нас — дословным JSON, для конфига. `undefined`
   * означает «не трогать сохранённое»: установка поверх уже стоящего хука
   * прежнее значение не видит, и перезаписать его на `null` значило бы потерять
   * чужую настройку навсегда.
   */
  previous?: string | null
  /** Пусто — получилось. */
  problems: string[]
}

/**
 * Поставить хук в `~/.claude/settings.json`.
 *
 * Файл читается, правится одним ключом и пишется обратно: чужие настройки в нём
 * — не наше дело, и потерять их при записи целиком было бы худшим исходом
 * этапа. Битый JSON — повод отказаться, а не переписать: перезапись «починила
 * бы» файл, стерев всё, что в нём было.
 */
export function installHook(host: StatuslineHost): InstallResult {
  const settings = readSettings(host)
  if (settings.problem !== undefined) return { problems: [settings.problem] }
  const data = settings.data ?? {}
  const current = data['statusLine']
  const path = hookPath(host)
  const ours = commandOf(current) === path

  writeHookFile(host)
  if (!ours) writeChain(host, commandOf(current))

  data['statusLine'] = { type: 'command', command: path }
  const problem = writeSettings(host, data)
  if (problem !== undefined) return { problems: [problem] }
  if (ours) return { problems: [] }
  return { previous: current === undefined ? null : JSON.stringify(current), problems: [] }
}

/**
 * Снять хук и вернуть строку состояния ровно в прежний вид.
 *
 * Журнал и разобранное при этом остаются: наблюдения ретроспективе не
 * поддаются — до установки хука процентов не знает никто, — и стереть их
 * заодно с настройкой значило бы потерять единственные данные этапа.
 */
export function removeHook(host: StatuslineHost, previous: string | null): string[] {
  const settings = readSettings(host)
  if (settings.problem !== undefined) return [settings.problem]
  const data = settings.data ?? {}
  if (commandOf(data['statusLine']) === hookPath(host)) {
    const restored = parse(previous)
    if (restored === undefined) delete data['statusLine']
    else data['statusLine'] = restored
    const problem = writeSettings(host, data)
    if (problem !== undefined) return [problem]
  }
  rmSync(chainPath(host), { force: true })
  return []
}

/**
 * Переписать тело хука, если оно устарело.
 *
 * Зовётся при старте: обновление приложения меняет текст хука, а файл лежит в
 * каталоге настроек и сам собой не обновится. Проверка по содержимому, а не по
 * версии в имени: имя должно остаться прежним — на него ссылается чужой файл.
 */
export function refreshHook(host: StatuslineHost): void {
  const path = hookPath(host)
  if (!existsSync(path)) return
  const body = hookBody(host.platform)
  try {
    if (readFileSync(path, 'utf8') !== body) writeHookFile(host)
  } catch {
    writeHookFile(host)
  }
}

function writeHookFile(host: StatuslineHost): void {
  const path = hookPath(host)
  mkdirSync(host.configDir, { recursive: true })
  writeFileSync(path, hookBody(host.platform), 'utf8')
  // Без бита исполнения Claude Code запустит хук и получит EACCES — тихо, в
  // строке состояния просто ничего не появится.
  if (host.platform !== 'win32') chmodSync(path, 0o755)
}

function writeChain(host: StatuslineHost, command: string | undefined): void {
  const path = chainPath(host)
  if (command === undefined || command === '') {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(host.configDir, { recursive: true })
  writeFileSync(path, command, 'utf8')
}

function readChain(host: StatuslineHost): string | undefined {
  const path = chainPath(host)
  if (!existsSync(path)) return undefined
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

interface SettingsRead {
  data?: Record<string, unknown>
  problem?: string
}

function readSettings(host: StatuslineHost): SettingsRead {
  if (!existsSync(host.claudeHome)) {
    return { problem: t('settings.usageNoClaude', { path: host.claudeHome }) }
  }
  const path = claudeSettingsPath(host)
  if (!existsSync(path)) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { problem: t('settings.usageBadSettings', { path }) }
    }
    return { data: raw as Record<string, unknown> }
  } catch {
    return { problem: t('settings.usageBadSettings', { path }) }
  }
}

function writeSettings(host: StatuslineHost, data: Record<string, unknown>): string | undefined {
  const path = claudeSettingsPath(host)
  try {
    mkdirSync(host.claudeHome, { recursive: true })
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return t('settings.usageBadSettings', { path: `${path}: ${(error as Error).message}` })
  }
}

/** Команда из значения `statusLine` — оно бывает объектом и бывает строкой. */
function commandOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const command = (value as Record<string, unknown>)['command']
  return typeof command === 'string' ? command : undefined
}

function parse(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Журнал наблюдений в памяти: что уже записано и что из этого вышло.
 *
 * Ключи прочитанного держатся множеством, а не сверкой с файлом на каждый
 * снимок: хук зовётся на каждую отрисовку строки состояния, то есть десятки раз
 * на одно наблюдение, и перечитывать ради этого журнал значило бы читать файл
 * чаще, чем он растёт.
 */
export interface UsageJournal {
  path: string
  seen: Set<string>
  snapshots: UsageSnapshot[]
  calibration: Calibration | null
  /** Когда калибровка считалась последний раз — вход троттлинга. */
  calibratedAt: number
  /** Время снимка, который уже разобрали, — чтобы не читать файл заново. */
  latestAt: number
}

export function openJournal(host: StatuslineHost): UsageJournal {
  const path = journalPath(host)
  const snapshots = readUsageJournal(path)
  return {
    path,
    seen: new Set(snapshots.flatMap(usageKeys)),
    snapshots,
    calibration: null,
    calibratedAt: 0,
    latestAt: 0,
  }
}

/**
 * Дочитать снимок, оставленный хуком, и дописать журнал.
 *
 * Дедуп — по паре (процент, момент сброса) каждого окна: запись попадает в
 * журнал, если **хоть один** её ключ новый. Момент наблюдения берётся из
 * времени файла, а не из «сейчас»: файл пишет хук, а читаем мы с опозданием до
 * периода опроса, и в журнале должно стоять время наблюдения.
 *
 * `null` — записывать нечего: снимка нет, он не разбирается, в нём нет
 * `rate_limits` (первый запрос к API в сессии ещё не прошёл) или он уже
 * записан.
 */
export function drainSnapshot(
  host: StatuslineHost,
  journal: UsageJournal,
  now = Date.now(),
): UsageSnapshot | null {
  const path = latestPath(host)
  let raw: unknown
  let ts = now
  try {
    // Время файла спрашивается первым: снимок читается на каждый опрос трея, а
    // меняется раз в ход агента. Неизменившийся файл разбирать незачем.
    ts = statSync(path).mtimeMs
    if (ts === journal.latestAt) return null
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Файла нет вовсе (хук не стоял или его сняли) либо на диске половина
    // JSON: хук пишет через rename, но чужой хук в цепочке мог и не.
    return null
  }
  journal.latestAt = ts
  const snapshot = parseStatusLine(raw, Math.round(ts))
  if (snapshot === null) return null
  const keys = usageKeys(snapshot)
  if (keys.every((key) => journal.seen.has(key))) return null
  appendUsageJournal(journal.path, [snapshot])
  for (const key of keys) journal.seen.add(key)
  journal.snapshots.push(snapshot)
  return snapshot
}

/**
 * Пересчитать вес и потолки по журналу.
 *
 * Запросы читаются не за всю историю, а начиная с самого старого окна в
 * журнале: калибровке нужны дни, а не месяцы, а полный проход по запросам
 * Claude — это работа, которую нельзя делать на каждый снимок.
 */
export function recalibrate(db: Db, journal: UsageJournal, at = Date.now()): Calibration {
  const from = earliestWindowStart(journal.snapshots)
  const calibration = calibrate(journal.snapshots, readClaudeRequests(db, from))
  journal.calibration = calibration
  journal.calibratedAt = at
  return calibration
}

const WEEK_MS = 7 * 24 * 3_600_000

function earliestWindowStart(snapshots: readonly UsageSnapshot[]): number {
  let earliest = Number.POSITIVE_INFINITY
  for (const snapshot of snapshots) {
    if (snapshot.fiveHour) earliest = Math.min(earliest, snapshot.fiveHour.resetsAt - 5 * 3_600_000)
    if (snapshot.weekly) earliest = Math.min(earliest, snapshot.weekly.resetsAt - WEEK_MS)
  }
  return Number.isFinite(earliest) ? earliest : 0
}

/**
 * Строка раздела настроек: что стоит, сколько накоплено, что посчиталось.
 *
 * `problem` приезжает и от перечитывания, и от последней попытки записи —
 * потому что это разные отказы. Битый `settings.json` виден при чтении, а
 * запись, не прошедшую по правам, чтение не покажет вовсе: оно честно скажет
 * «не стоит», и тумблер щёлкнет молча.
 */
export function usageStatus(
  host: StatuslineHost,
  journal: UsageJournal,
  lastProblem?: string,
): UsageHookStatus {
  const state = readHook(host)
  const windows = new Set(
    journal.snapshots
      .map((snapshot) => snapshot.fiveHour?.resetsAt)
      .filter((resetsAt): resetsAt is number => resetsAt !== undefined),
  ).size
  const status: UsageHookStatus = {
    installed: state.installed,
    settingsPath: claudeSettingsPath(host),
    points: journal.snapshots.length,
    windows,
    weight: journal.calibration?.cacheReadWeight ?? null,
    hookVersion: HOOK_VERSION,
  }
  if (state.chained !== undefined) status.chained = state.chained
  const problem = lastProblem ?? state.problem
  if (problem !== undefined) status.problem = problem
  return status
}
