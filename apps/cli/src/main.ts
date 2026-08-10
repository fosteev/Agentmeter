#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  breakdownReport,
  claudeHome,
  codexHome,
  configPath as defaultConfigPath,
  createLiveLayer,
  dayRange,
  defaultIndexPath,
  doctorReport,
  ensureLimitWindows,
  ingestAll,
  limitsReport,
  loadConfig,
  openDb,
  taskRows,
  todayReport,
  type Config,
  type DayRange,
  type Provider,
} from '@agentmeter/core'
import { renderBreakdown, type BreakdownAxis } from './commands/breakdown.ts'
import { renderDoctor } from './commands/doctor.ts'
import { renderLimits } from './commands/limits.ts'
import { renderLive } from './commands/live.ts'
import { renderTasks } from './commands/tasks.ts'
import { renderToday } from './commands/today.ts'

const COMMANDS = [
  'today',
  'tasks',
  'breakdown',
  'limits',
  'live',
  'doctor',
  'verify',
  'index',
] as const
type Command = (typeof COMMANDS)[number]

interface CommonOptions {
  indexPath: string
  configPath: string
  noIngest: boolean
  json: boolean
  rest: string[]
}

function usage(): string {
  return [
    'agentmeter <команда> [параметры]',
    '',
    `команды: ${COMMANDS.join(', ')}`,
    '',
    'общие флаги: --index <path> --config <path> --no-ingest --json',
    'today     [--day YYYY-MM-DD] [--days N] [--provider claude|codex]',
    'tasks     [--day YYYY-MM-DD] [--limit N]',
    'breakdown [--day YYYY-MM-DD] [--session <id>] [--by tool|server|skill|agent|model]',
    'limits',
    'live',
    'doctor',
    'index     [--rebuild]',
  ].join('\n')
}

export function run(argv: readonly string[]): number {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }
  if (!COMMANDS.includes(command as Command)) {
    console.error(`неизвестная команда: ${command}`)
    return 2
  }
  if (command === 'verify') {
    console.error('команда verify не входит в этап 1.10 и пока не реализована')
    return 2
  }

  try {
    const common = parseCommon(argv.slice(1))
    const loaded = loadConfig(common.configPath)
    mkdirSync(dirname(common.indexPath), { recursive: true })
    if (command === 'index') return runIndex(common, loaded.config)

    const { db } = openDb(common.indexPath)
    try {
      if (!common.noIngest) ingest(db, loaded.config)
      switch (command) {
        case 'today':
          return runToday(db, common, loaded.config)
        case 'tasks':
          return runTasks(db, common, loaded.config)
        case 'breakdown':
          return runBreakdown(db, common, loaded.config)
        case 'limits':
          return runLimits(db, common, loaded.config)
        case 'live':
          return runLive(db, common, loaded.config)
        case 'doctor':
          return runDoctor(db, common, loaded.config, loaded.problems)
        default:
          throw new CliArgumentError(`команда ${command} не поддерживается`)
      }
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof CliArgumentError) {
      console.error(error.message)
      return 2
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function runToday(
  db: Parameters<typeof todayReport>[0],
  common: CommonOptions,
  config: Config,
): number {
  const values = parseValues(common.rest, new Set(['--day', '--days', '--provider']))
  const days = positiveInteger(values.get('--days') ?? '1', '--days')
  const provider = optionalProvider(values.get('--provider'))
  const endRange = rangeFor(values.get('--day'), config.ui.dayStartsAtHour)
  const range =
    days === 1
      ? endRange
      : {
          from: dayRange(endRange.from, config.ui.dayStartsAtHour, -(days - 1)).from,
          to: endRange.to,
        }
  const report = todayReport(db, range, provider)
  output(common.json ? report : renderToday(report, config.ui.locale), common.json)
  return 0
}

function runTasks(
  db: Parameters<typeof taskRows>[0],
  common: CommonOptions,
  config: Config,
): number {
  const values = parseValues(common.rest, new Set(['--day', '--limit']))
  const limit = values.has('--limit')
    ? positiveInteger(values.get('--limit')!, '--limit')
    : Number.MAX_SAFE_INTEGER
  const range = rangeFor(values.get('--day'), config.ui.dayStartsAtHour)
  const allRows = taskRows(db, range)
  const rows = allRows.slice(0, limit)
  const emptyIndex = sourceCount(db) === 0
  const value = { emptyIndex, emptyDay: allRows.length === 0, range, rows }
  output(
    common.json
      ? value
      : renderTasks(rows, { emptyIndex, rangeFrom: range.from, locale: config.ui.locale }),
    common.json,
  )
  return 0
}

function runBreakdown(
  db: Parameters<typeof breakdownReport>[0],
  common: CommonOptions,
  config: Config,
): number {
  const values = parseValues(common.rest, new Set(['--day', '--session', '--by']))
  if (values.has('--day') && values.has('--session')) {
    throw new CliArgumentError('--day и --session нельзя использовать вместе')
  }
  const axis = breakdownAxis(values.get('--by'))
  const scope = values.has('--session')
    ? { sessionId: values.get('--session')! }
    : { range: rangeFor(values.get('--day'), config.ui.dayStartsAtHour) }
  const report = breakdownReport(db, scope)
  output(
    common.json ? { ...report, by: axis } : renderBreakdown(report, axis, config.ui.locale),
    common.json,
  )
  return 0
}

function runLimits(
  db: Parameters<typeof limitsReport>[0],
  common: CommonOptions,
  config: Config,
): number {
  ensureNoArgs(common.rest)
  // Отчёт только читает (2.1). Пересборку по смене потолков плана делает
  // `ensureLimitWindows`: без неё `--no-ingest` показывал бы старые `null`,
  // то есть выдавал устаревший ответ за честное «план не задан».
  ensureLimitWindows(db, config.limits.claude)
  const report = limitsReport(db, Date.now(), config.limits.claude)
  output(common.json ? report : renderLimits(report, config.ui.locale), common.json)
  return 0
}

function runLive(
  db: Parameters<typeof createLiveLayer>[0],
  common: CommonOptions,
  config: Config,
): number {
  ensureNoArgs(common.rest)
  // Журнал замера из CLI не ведётся: одиночный вызов видит сессию один раз и
  // смерти процесса не наблюдает никогда, а запись «увидел и потерял» на
  // каждый запуск команды засорила бы замер выдумкой.
  const live = createLiveLayer(db, {
    claudeHome: claudeHome(config),
    codexHome: codexHome(config),
    idleMs: config.live.idleMs,
    codexSilenceMs: config.live.codexSilenceMs,
    claudeLimits: config.limits.claude,
  })
  const snapshot = live.snapshot()
  output(common.json ? snapshot : renderLive(snapshot, config.ui.locale), common.json)
  return 0
}

function runDoctor(
  db: Parameters<typeof doctorReport>[0],
  common: CommonOptions,
  config: Config,
  configProblems: string[],
): number {
  ensureNoArgs(common.rest)
  const report = doctorReport(db, config)
  output(
    common.json
      ? { ...report, configProblems }
      : renderDoctor(report, config.ui.locale, configProblems),
    common.json,
  )
  return report.parserErrors > 0 ? 1 : 0
}

function runIndex(common: CommonOptions, config: Config): number {
  if (common.noIngest) throw new CliArgumentError('--no-ingest неприменим к команде index')
  const values = parseSwitches(common.rest, new Set(['--rebuild']))
  if (values.has('--rebuild')) removeIndex(common.indexPath)
  const { db } = openDb(common.indexPath)
  try {
    const stats = ingest(db, config)
    output(
      common.json
        ? stats
        : `scanned=${stats.scanned} parsed=${stats.parsed} skipped=${stats.skipped} removed=${stats.removed} failed=${stats.failed} sessions=${stats.sessions} requests=${stats.requests} ms=${stats.ms}`,
      common.json,
    )
    return stats.failed === 0 ? 0 : 1
  } finally {
    db.close()
  }
}

function ingest(db: Parameters<typeof ingestAll>[0], config: Config) {
  return ingestAll(db, {
    claudeHome: claudeHome(config),
    codexHome: codexHome(config),
    extra: config.sources.extra,
    claudeLimits: config.limits.claude,
  })
}

function parseCommon(argv: readonly string[]): CommonOptions {
  let indexPath = defaultIndexPath()
  let configPath = defaultConfigPath()
  let noIngest = false
  let json = false
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--json') json = true
    else if (arg === '--no-ingest') noIngest = true
    else if (arg === '--index' || arg === '--config') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new CliArgumentError(`${arg} требует значение`)
      if (arg === '--index') indexPath = value
      else configPath = value
      index += 1
    } else rest.push(arg)
  }
  return { indexPath, configPath, noIngest, json, rest }
}

function parseValues(argv: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!allowed.has(arg)) throw new CliArgumentError(`неизвестный флаг: ${arg}`)
    if (values.has(arg)) throw new CliArgumentError(`флаг ${arg} указан дважды`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new CliArgumentError(`${arg} требует значение`)
    values.set(arg, value)
    index += 1
  }
  return values
}

function parseSwitches(argv: readonly string[], allowed: ReadonlySet<string>): Set<string> {
  const values = new Set<string>()
  for (const arg of argv) {
    if (!allowed.has(arg)) throw new CliArgumentError(`неизвестный флаг: ${arg}`)
    if (values.has(arg)) throw new CliArgumentError(`флаг ${arg} указан дважды`)
    values.add(arg)
  }
  return values
}

function ensureNoArgs(argv: readonly string[]): void {
  if (argv.length > 0) throw new CliArgumentError(`неизвестный флаг: ${argv[0]}`)
}

function rangeFor(day: string | undefined, dayStartsAtHour: number): DayRange {
  if (day === undefined) return dayRange(Date.now(), dayStartsAtHour)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new CliArgumentError(`неверная дата: ${day}`)
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const date = Number(match[3])
  const local = new Date(year, month, date, dayStartsAtHour)
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month ||
    local.getDate() !== date ||
    local.getHours() !== dayStartsAtHour
  ) {
    throw new CliArgumentError(`неверная дата: ${day}`)
  }
  return dayRange(local.getTime(), dayStartsAtHour)
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliArgumentError(`${name} должен быть положительным целым числом`)
  }
  return parsed
}

function optionalProvider(value: string | undefined): Provider | undefined {
  if (value === undefined) return undefined
  if (value === 'claude' || value === 'codex') return value
  throw new CliArgumentError('--provider должен быть claude или codex')
}

function breakdownAxis(value: string | undefined): BreakdownAxis {
  if (value === undefined) return 'tool'
  if (['tool', 'server', 'skill', 'agent', 'model'].includes(value)) {
    return value as BreakdownAxis
  }
  throw new CliArgumentError('--by должен быть tool, server, skill, agent или model')
}

function sourceCount(db: Parameters<typeof taskRows>[0]): number {
  return db.get<{ count: number }>('SELECT count(*) AS count FROM sources')?.count ?? 0
}

function output(value: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(value) : String(value))
}

function removeIndex(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${path}${suffix}`
    if (existsSync(candidate)) rmSync(candidate, { force: true })
  }
}

class CliArgumentError extends Error {}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)))
}
