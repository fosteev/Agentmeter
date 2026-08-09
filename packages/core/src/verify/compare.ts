/**
 * Сверка нашего подсчёта с эталоном самого Claude Code.
 *
 * Эталон лежит в `~/.claude.json` (`lastTotal*Tokens`, `lastModelUsage`) и
 * снят в `fixtures/ground-truth.json`. Он независим: цифры посчитаны не нами.
 *
 * Здесь только арифметика сравнения — чтение логов и разбор снаружи. Так эту
 * часть можно проверять тестами, не имея под рукой ни одного живого лога.
 *
 * Важное про смысл расхождений (см. `docs/roadmap/1.3-verify.md`):
 * эталон **сам недосчитывает сабагентов** — он берёт usage только последнего
 * их запроса. Поэтому сверка идёт в эталон-совместимом режиме, а пользователю
 * показывается полный расход. Считать эталон истиной во всём — значит
 * сознательно занижать цифры.
 */
import type { Request } from '../sources/types.ts'

export interface Totals {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface GroundTruthEntry {
  project: string
  sessionId: string
  totals: Totals
  /** Разбивка по моделям: она показывает, чей именно класс запросов недостаёт. */
  byModel?: Record<string, ModelUsage>
}

export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export interface Comparison {
  project: string
  sessionId: string
  expected: Totals
  actual: Totals
  /** эталон − наше: положительное значит недобор. */
  diff: Totals
  exact: boolean
  /** Недобор чтения кэша в долях эталона, для сортировки худших. */
  cacheReadDrift: number
  /**
   * Кратность недобора последнему префиксу. Хвостовые служебные запросы дают
   * целое: 1.00, 2.01. Дробное значение — расхождение другой природы, и его
   * надо разбирать отдельно, а не списывать на хвост.
   */
  tailUnits?: number
  /** Модели, которых в транскрипте нет вовсе, — служебные вызовы Haiku. */
  missingModels: string[]
}

export interface VerifyReport {
  comparisons: Comparison[]
  checked: number
  exact: number
  /** Записи эталона, для которых файла сессии на диске не нашлось. */
  missing: string[]
  worstDrift: number
}

export const ZERO: Totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

export function sumRequests(requests: readonly Request[]): Totals {
  return requests.reduce<Totals>(
    (a, r) => ({
      input: a.input + r.input,
      output: a.output + r.output,
      cacheWrite: a.cacheWrite + r.cacheWrite,
      cacheRead: a.cacheRead + r.cacheRead,
    }),
    { ...ZERO },
  )
}

/** Модели, за которые эталон отчитался, но в разобранных запросах их нет. */
export function missingModels(
  byModel: Record<string, ModelUsage> | undefined,
  requests: readonly Request[],
): string[] {
  if (!byModel) return []
  const seen = new Set(requests.map((r) => r.model))
  return Object.entries(byModel)
    .filter(([model, usage]) => {
      if (seen.has(model)) return false
      // Модель без единого токена — не недостача, а пустая строка отчёта.
      const total =
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheReadInputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0)
      return total > 0
    })
    .map(([model]) => model)
    .sort()
}

/**
 * Последний префикс сессии: `cacheRead + cacheWrite` последнего запроса.
 * По нему меряется хвостовая недостача — служебные запросы после последнего
 * ответа следа в логе не оставляют, но стоят ровно префикс каждый.
 */
export function lastPrefix(requests: readonly Request[]): number {
  const last = requests.at(-1)
  return last ? last.cacheRead + last.cacheWrite : 0
}

export function compareOne(
  entry: GroundTruthEntry,
  requests: readonly Request[],
): Comparison {
  const actual = sumRequests(requests)
  const expected = entry.totals
  const diff: Totals = {
    input: expected.input - actual.input,
    output: expected.output - actual.output,
    cacheWrite: expected.cacheWrite - actual.cacheWrite,
    cacheRead: expected.cacheRead - actual.cacheRead,
  }
  const prefix = lastPrefix(requests)
  const comparison: Comparison = {
    project: entry.project,
    sessionId: entry.sessionId,
    expected,
    actual,
    diff,
    exact: diff.cacheRead === 0 && diff.cacheWrite === 0 && diff.output === 0,
    cacheReadDrift: expected.cacheRead === 0 ? 0 : diff.cacheRead / expected.cacheRead,
    missingModels: missingModels(entry.byModel, requests),
  }
  if (prefix > 0) comparison.tailUnits = round2(diff.cacheRead / prefix)
  return comparison
}

export function buildReport(comparisons: Comparison[], missing: string[]): VerifyReport {
  return {
    comparisons: [...comparisons].sort((a, b) => Math.abs(b.cacheReadDrift) - Math.abs(a.cacheReadDrift)),
    checked: comparisons.length,
    exact: comparisons.filter((c) => c.exact).length,
    missing,
    worstDrift: comparisons.reduce((w, c) => Math.max(w, Math.abs(c.cacheReadDrift)), 0),
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
