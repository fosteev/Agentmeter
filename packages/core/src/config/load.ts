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
import { DEFAULT_CONFIG, type Config } from './types.ts'

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
      problems: [`${path}: не разбирается как JSON (${(e as Error).message}), взяты значения по умолчанию`],
    }
  }
  return merge(raw)
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
  return { config: result as unknown as Config, problems }
}

function walk(
  defaults: Record<string, unknown>,
  value: unknown,
  path: string,
  problems: string[],
): Record<string, unknown> {
  const source = isPlainObject(value) ? value : {}
  if (value !== undefined && !isPlainObject(value)) {
    problems.push(`${path || '<корень>'}: ожидался объект, взято значение по умолчанию`)
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
      problems.push(`${here}: ожидалось ${describe(def)}, пришло ${describe(got)} — взят дефолт`)
      out[key] = structuredClone(def)
      continue
    }
    out[key] = got
  }
  return out
}

/** `null` в дефолте означает «значение неизвестно», а не «тип null». */
function typeMatches(def: unknown, got: unknown): boolean {
  if (Array.isArray(def)) return Array.isArray(got) && got.every((v) => typeof v === 'string')
  if (def === null) return got === null || typeof got === 'number' || typeof got === 'string'
  return typeof def === typeof got
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'список'
  return typeof v
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
