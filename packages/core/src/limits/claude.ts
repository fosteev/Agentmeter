import type { ClaudeLimits } from '../config/types.ts'
import type { LimitUsage, LimitWindow, Request } from '../sources/types.ts'

const MINUTE_MS = 60_000

interface ClaudeWindowSpec {
  kind: 'fiveHour' | 'weekly'
  windowMinutes: 300 | 10_080
  cap: number | null
}

/** Запросы Claude (из всех сессий сразу) → окна с расходом. */
export function buildClaudeWindows(requests: Request[], limits: ClaudeLimits): LimitWindow[] {
  const sorted = [...requests].sort((left, right) => left.ts - right.ts)
  const specs: ClaudeWindowSpec[] = [
    { kind: 'fiveHour', windowMinutes: 300, cap: limits.fiveHourCap },
    { kind: 'weekly', windowMinutes: 10_080, cap: limits.weeklyCap },
  ]
  const windows = specs.flatMap((spec) => buildWindows(sorted, spec, limits.cacheReadWeight))
  return windows.sort(
    (left, right) =>
      left.startsAt - right.startsAt ||
      left.windowMinutes - right.windowMinutes ||
      left.resetsAt - right.resetsAt,
  )
}

function buildWindows(
  requests: Request[],
  spec: ClaudeWindowSpec,
  cacheReadWeight: number | null,
): LimitWindow[] {
  const windows: LimitWindow[] = []

  for (const request of requests) {
    let current = windows.at(-1)
    // Окно фиксировано первым запросом после сброса, а не календарной сеткой.
    if (!current || request.ts >= current.resetsAt) {
      current = createWindow(request, spec, cacheReadWeight)
      windows.push(current)
    } else {
      addRequest(current, request, spec.cap, cacheReadWeight)
    }
  }

  return windows
}

function createWindow(
  request: Request,
  spec: ClaudeWindowSpec,
  cacheReadWeight: number | null,
): LimitWindow {
  const usage = emptyUsage()
  const window: LimitWindow = {
    provider: 'claude',
    kind: spec.kind,
    windowMinutes: spec.windowMinutes,
    startsAt: request.ts,
    resetsAt: request.ts + spec.windowMinutes * MINUTE_MS,
    usedPercent: null,
    observedAt: request.ts,
    exact: false,
    usage,
  }
  addRequest(window, request, spec.cap, cacheReadWeight)
  return window
}

function addRequest(
  window: LimitWindow,
  request: Request,
  cap: number | null,
  cacheReadWeight: number | null,
): void {
  const usage = window.usage!

  // Восстановленные, сайдчейновые и synthetic-запросы провайдер тарифицирует
  // на общих правах, поэтому здесь намеренно нет фильтров.
  usage.input += request.input
  usage.output += request.output
  usage.cacheWrite += request.cacheWrite
  usage.cacheRead += request.cacheRead
  usage.requests += 1
  window.observedAt = request.ts

  // null означает неизвестный вес, а не бесплатное чтение кэша.
  usage.weighted =
    cacheReadWeight === null
      ? null
      : usage.input + usage.cacheWrite + usage.output + cacheReadWeight * usage.cacheRead
  window.usedPercent =
    usage.weighted === null || cap === null
      ? null
      : Math.round((usage.weighted / cap) * 100 * 100) / 100
}

function emptyUsage(): LimitUsage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, weighted: null, requests: 0 }
}
