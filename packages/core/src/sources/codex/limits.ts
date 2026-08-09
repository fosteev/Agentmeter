import { readFileSync } from 'node:fs'
import type { LimitObservation } from '../types.ts'

type JsonObject = Record<string, unknown>

/**
 * Сырые наблюдения лимита из одного роллаута, в порядке появления.
 *
 * Имя слота (`primary`/`secondary`) сюда не попадает намеренно: до Codex CLI
 * 0.145.0 `primary` был пятичасовым, с 0.145.0 стал недельным. Единственный
 * надёжный признак вида окна — его длина.
 */
export function readLimits(path: string): LimitObservation[] {
  const observations: LimitObservation[] = []

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = parseObject(line)
    if (record) appendLimitObservations(observations, record)
  }

  return observations
}

/**
 * Разбирает `rate_limits` уже прочитанной записи роллаута.
 *
 * Парсер сессии и отдельная проба лимитов обязаны идти одним путём: второе
 * чтение растущего файла способно дать другой набор наблюдений.
 */
export function appendLimitObservations(
  observations: LimitObservation[],
  record: Record<string, unknown>,
): void {
  const payload = objectField(record, 'payload')
  if (
    stringField(record, 'type') !== 'event_msg' ||
    stringField(payload ?? {}, 'type') !== 'token_count'
  ) {
    return
  }

  const rateLimits = objectField(payload ?? {}, 'rate_limits')
  if (!rateLimits) return
  const ts = Date.parse(stringField(record, 'timestamp') ?? '')
  for (const slot of ['primary', 'secondary'] as const) {
    append(observations, ts, objectField(rateLimits, slot))
  }
}

function append(
  observations: LimitObservation[],
  ts: number,
  payload: JsonObject | undefined,
): void {
  if (!payload) return
  const usedPercent = numberField(payload, 'used_percent')
  const windowMinutes = numberField(payload, 'window_minutes')
  const resetsAt = numberField(payload, 'resets_at')
  // Без `resets_at` наблюдение бесполезно: границ окна из него не построить,
  // а класть его в «текущее окно» наугад — тихо соврать.
  if (usedPercent === undefined || windowMinutes === undefined || resetsAt === undefined) return
  if (!Number.isFinite(ts)) return

  observations.push({ ts, windowMinutes, usedPercent, resetsAt: resetsAt * 1000 })
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
