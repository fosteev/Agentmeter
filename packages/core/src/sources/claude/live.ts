import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Entrypoint, LiveSession } from '../types.ts'

type JsonObject = Record<string, unknown>

const ENTRYPOINTS = new Set<Entrypoint>(['cli', 'vscode', 'jetbrains', 'desktop', 'sdk', 'exec', 'unknown'])

export function listLiveSessions(dir = join(homedir(), '.claude', 'sessions')): LiveSession[] {
  if (!existsSync(dir)) return []

  const sessions: LiveSession[] = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const session = readLiveSession(join(dir, file), file)
    if (session && isPidAlive(session.pid)) sessions.push(session)
  }
  return sessions.sort((a, b) => a.startedAt - b.startedAt)
}

function readLiveSession(path: string, fileName: string): LiveSession | undefined {
  try {
    const raw = asObject(JSON.parse(readFileSync(path, 'utf8')))
    if (!raw) return undefined
    const pid = numberField(raw, 'pid') ?? pidFromFile(fileName)
    const sessionId = stringField(raw, 'sessionId') ?? stringField(raw, 'session_id')
    const cwd = stringField(raw, 'cwd')
    const startedAt = timestampField(raw, 'startedAt') ?? timestampField(raw, 'started_at')
    if (pid === undefined || !sessionId || !cwd || startedAt === undefined) return undefined

    const entrypoint = entrypointField(raw, 'entrypoint') ?? 'unknown'
    const session: LiveSession = {
      pid,
      sessionId,
      provider: 'claude',
      cwd,
      startedAt,
      entrypoint,
    }
    const cliVersion = stringField(raw, 'cliVersion') ?? stringField(raw, 'version')
    const name = stringField(raw, 'name')
    if (cliVersion !== undefined) session.cliVersion = cliVersion
    if (name !== undefined) session.name = name
    return session
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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

function entrypointField(object: JsonObject, key: string): Entrypoint | undefined {
  const value = stringField(object, key)
  return value !== undefined && ENTRYPOINTS.has(value as Entrypoint) ? (value as Entrypoint) : undefined
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
