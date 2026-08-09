import { readFileSync } from 'node:fs'
import type { LimitWindow } from '../types.ts'

type JsonObject = Record<string, unknown>

export function readLimits(path: string): LimitWindow[] {
  const windows: LimitWindow[] = []

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = parseObject(line)
    if (!record) continue
    const payload = objectField(record, 'payload')
    if (stringField(record, 'type') !== 'event_msg' || stringField(payload ?? {}, 'type') !== 'token_count') continue

    const rateLimits = objectField(payload ?? {}, 'rate_limits')
    if (!rateLimits) continue
    appendWindow(windows, 'primary', objectField(rateLimits, 'primary'))
    appendWindow(windows, 'secondary', objectField(rateLimits, 'secondary'))
  }

  return windows
}

function appendWindow(windows: LimitWindow[], kind: 'primary' | 'secondary', payload: JsonObject | undefined): void {
  if (!payload) return
  const usedPercent = numberField(payload, 'used_percent')
  const windowMinutes = numberField(payload, 'window_minutes')
  if (usedPercent === undefined || windowMinutes === undefined) return

  const window: LimitWindow = {
    provider: 'codex',
    kind,
    usedPercent,
    windowMinutes,
    exact: true,
  }
  const resetsAt = numberField(payload, 'resets_at')
  if (resetsAt !== undefined) window.resetsAt = resetsAt * 1000
  windows.push(window)
}

function parseObject(line: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(line))
  } catch {
    return undefined
  }
}

function objectField(object: JsonObject, key: string): JsonObject | undefined {
  return asObject(object[key])
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}
