/**
 * Чтение и запись конфига, пути по умолчанию для трёх платформ.
 *
 * Битый или частичный конфиг не роняет приложение и не заменяется молча:
 * непонятные поля заменяются дефолтом, а список замен возвращается вызывающему
 * — иначе пользователь будет считать, что его настройка применена, когда она
 * тихо отброшена.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from '../i18n/index.ts'
import { DEFAULT_CONFIG, type Config } from './types.ts'
import { RULES } from './validate.ts'

/** Каталог настроек приложения. `AGENTMETER_HOME` перекрывает всё — нужен тестам. */
export function configDir(): string {
  const override = process.env['AGENTMETER_HOME']
  if (override) return override
  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Agentmeter')
    case 'win32':
      return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Agentmeter')
    default:
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'agentmeter')
  }
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

/** Индекс лежит рядом с конфигом: снести его безопасно, данные производные. */
export function indexPath(): string {
  return join(configDir(), 'index.sqlite')
}

/**
 * Журнал времени жизни сессий — единственное в проекте, что не производно от
 * логов. Поэтому он лежит **рядом** с индексом, а не внутри: пересборка базы
 * («снести и перечитать», правило 3 в `schema.ts`) не должна его касаться.
 */
export function lifetimesPath(): string {
  return join(configDir(), 'lifetimes.jsonl')
}

export function claudeHome(cfg: Config): string {
  return cfg.sources.claudeHome ?? join(homedir(), '.claude')
}

export function codexHome(cfg: Config): string {
  return cfg.sources.codexHome ?? join(homedir(), '.codex')
}

export interface LoadResult {
  config: Config
  /** Поля, которые пришлось заменить дефолтом, и почему. */
  problems: string[]
}

export function loadConfig(path = configPath()): LoadResult {
  if (!existsSync(path)) return { config: structuredClone(DEFAULT_CONFIG), problems: [] }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      problems: [t('config.badJson', { path, message: (e as Error).message })],
    }
  }
  return merge(raw)
}

/**
 * Применить частичную правку к живому конфигу (3.6, канал `config:set`).
 *
 * Тем же обходом, что и загрузка, только основой берётся текущий конфиг, а не
 * дефолт: поля, которых в правке нет, остаются как были, а непонятое значение
 * откатывается к **текущему**, а не к заводскому. Второй обход рядом означал
 * бы, что настройка, пришедшая из окна, проверяется не так, как та же
 * настройка, прочитанная с диска, — и однажды окно запишет то, чего файл не
 * принимает.
 */
export function applyPatch(current: Config, patch: unknown): LoadResult {
  const problems: string[] = []
  const result = walk(current as unknown as Record<string, unknown>, patch, '', problems)
  const config = result as unknown as Config
  crossChecks(config, current, problems)
  return { config, problems }
}

export function saveConfig(config: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Сливает прочитанное с дефолтами по форме дефолта: чего нет — берётся из
 * дефолта, что не того типа — тоже, с записью в `problems`. Лишние ключи
 * игнорируются молча: конфиг мог быть написан более новой версией.
 */
function merge(raw: unknown): LoadResult {
  const problems: string[] = []
  const result = walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, raw, '', problems)
  const config = result as unknown as Config
  crossChecks(config, DEFAULT_CONFIG, problems)
  return { config, problems }
}

/**
 * Проверки, которых не видно по одному полю.
 *
 * Порог тревоги ниже порога предупреждения — не опечатка в типе и не выход за
 * диапазон: оба числа допустимы порознь. Вместе они означают, что приложение
 * сначала бьёт тревогу, а потом предупреждает, и объяснить это на экране
 * нечем. Откатывается пара целиком — правильного значения из двух неверных не
 * выводится.
 */
function crossChecks(config: Config, fallback: Config, problems: string[]): void {
  if (config.alerts.warnAtPercent <= config.alerts.dangerAtPercent) return
  problems.push(
    t('config.warnAboveDanger', {
      warn: config.alerts.warnAtPercent,
      danger: config.alerts.dangerAtPercent,
    }),
  )
  config.alerts.warnAtPercent = fallback.alerts.warnAtPercent
  config.alerts.dangerAtPercent = fallback.alerts.dangerAtPercent
}

function walk(
  defaults: Record<string, unknown>,
  value: unknown,
  path: string,
  problems: string[],
): Record<string, unknown> {
  const source = isPlainObject(value) ? value : {}
  if (value !== undefined && !isPlainObject(value)) {
    problems.push(t('config.expectedObject', { path: path || t('config.root') }))
  }
  const out: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(defaults)) {
    const here = path ? `${path}.${key}` : key
    const got = source[key]
    if (isPlainObject(def)) {
      out[key] = walk(def as Record<string, unknown>, got, here, problems)
      continue
    }
    if (got === undefined) {
      out[key] = structuredClone(def)
      continue
    }
    if (!typeMatches(def, got)) {
      problems.push(t('config.badType', { path: here, expected: describe(def), got: describe(got) }))
      out[key] = structuredClone(def)
      continue
    }
    // Тип совпал — теперь значение. Без этой проверки `"theme": "chartreuse"`
    // и `"locale": "de"` проходили молча: обе строки — строки (3.6).
    const rule = RULES[here]
    if (rule !== undefined && !rule.ok(got)) {
      problems.push(t('config.badValue', { path: here, expected: rule.expected, got: show(got) }))
      out[key] = structuredClone(def)
      continue
    }
    out[key] = got
  }
  return out
}

function show(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value)
}

/** `null` в дефолте означает «значение неизвестно», а не «тип null». */
function typeMatches(def: unknown, got: unknown): boolean {
  if (Array.isArray(def)) return Array.isArray(got) && got.every((v) => typeof v === 'string')
  if (def === null) return got === null || typeof got === 'number' || typeof got === 'string'
  return typeof def === typeof got
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return t('config.typeList')
  if (typeof v === 'number') return t('config.typeNumber')
  if (typeof v === 'string') return t('config.typeString')
  if (typeof v === 'boolean') return t('config.typeBoolean')
  return typeof v
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
