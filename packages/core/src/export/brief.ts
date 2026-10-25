/**
 * Бриф для ИИ (7.7) — третий формат выгрузки, рядом с CSV и JSON (4.8).
 *
 * Смысл файла: человек скармливает его внешней модели и просит советов по
 * экономии. Отсюда два решения, на которых бриф держится.
 *
 * **Первое: числа собираются теми же функциями, что экраны.** Итог — из
 * `todayReport`, доли — из `spendSplit`, статьи — из `loadedCategories`, советы
 * — из `savings`. Второй сбор «почти как там» разошёлся бы с окном молча, и
 * внешний ИИ строил бы советы на числах, которых человек на экране не видел.
 *
 * **Второе: вместе с числами едут правила чтения.** Внешняя модель не знает,
 * что при отложенных тулах сервер MCP стоит на порядок дешевле (1.7), что
 * пересборка кэша не добавляет дню ни одного токена (4.4) и что постоянное —
 * это перечитывание, а не первая загрузка (4.1). Голые числа без этих правил —
 * приглашение к советам, которые проект уже опроверг замерами. По той же
 * причине оценка помечается словами: «нижняя оценка» у восстановленных
 * запросов, «не измерено» у жадных сессий — внешний ИИ обязан отличать факт от
 * гипотезы, и различие едет в самом файле.
 *
 * Формат — markdown, а не таблица: модели читают его лучше CSV, а человеку он
 * остаётся отчётом. Структурированные данные (`AiBrief`) отдаются отдельно —
 * CLI печатает их по `--json`, и оба вида собраны из одного объекта, разойтись
 * им не из чего.
 */
import { t } from '../i18n/index.ts'
import type { Db } from '../index/db.ts'
import { categoryLabel, toolBreakdownRows, toolRowLabel } from '../query/breakdown.ts'
import { cacheRebuilds, type RebuildEvent, type RebuildGroup } from '../query/cache.ts'
import { loadedCategories, type LoadedCategory } from '../query/loaded.ts'
import { projectRowLabel, spendMatrix } from '../query/matrix.ts'
import { savings, type Saving } from '../query/savings.ts'
import { SPEED } from '../query/speed.ts'
import { spendSplit } from '../query/split.ts'
import { todayReport } from '../query/today.ts'
import type { DayRange, MatrixCell, MatrixRow, Totals } from '../query/types.ts'
import { isoDate } from './index.ts'

export interface BriefTool {
  /** Ключ строки инструмента; на печати — через `toolRowLabel`. */
  key: string
  calls: number
  tokens: number
}

export interface BriefCache {
  measurable: boolean
  ttlMs: number
  start: RebuildGroup
  pause: RebuildGroup
  early: RebuildGroup
  compact: RebuildGroup
  /** Записано в кэш всеми событиями вместе. */
  tokens: number
  worst: RebuildEvent | null
}

export interface AiBrief {
  range: DayRange
  /** В периоде есть восстановленные запросы (1.3): итог — нижняя оценка. */
  approximate: boolean
  /** `null` — запросов за период нет, и это не ноль расхода. */
  totals: Totals | null
  sessions: number
  split: { total: number; recurring: number; marginal: number; firstRead: number }
  categories: LoadedCategory[]
  advice: Saving[]
  /** По убыванию расхода — порядок задаёт `toolBreakdownRows`. */
  tools: BriefTool[]
  /**
   * Маргиналь `spendMatrix` как есть (8.3): модели со скоростью, по убыванию
   * расхода. Тип ядра, а не копия — второй сбор «почти как в окне» разошёлся бы
   * с ним молча.
   */
  models: MatrixCell[]
  /** Строки `spendMatrix` как есть: проект, его итог и все клетки. */
  projects: MatrixRow[]
  cache: BriefCache
}

export function aiBrief(db: Db, range: DayRange): AiBrief {
  const report = todayReport(db, range)
  const split = spendSplit(db, range)
  const cache = cacheRebuilds(db, { range })
  // Один вызов на оба поля: две отдельные матрицы за один бриф — это два
  // снимка двух моментов, а не один.
  const matrix = spendMatrix(db, range)
  return {
    range,
    approximate: report.approximate,
    totals: report.totals,
    sessions: report.sessions ?? 0,
    split: {
      total: split.total,
      recurring: split.recurring,
      marginal: split.marginal,
      firstRead: split.firstRead,
    },
    categories: loadedCategories(db, range),
    advice: savings(db, range),
    tools: toolBreakdownRows(db, { range }).map((row) => ({
      key: row.key,
      calls: row.calls.measured + row.calls.split + row.calls.unknown,
      tokens: row.tokens.measured + row.tokens.split + row.tokens.unknown,
    })),
    models: matrix.models,
    projects: matrix.rows,
    cache: {
      measurable: cache.measurable,
      ttlMs: cache.ttlMs,
      start: cache.start,
      pause: cache.pause,
      early: cache.early,
      compact: cache.compact,
      tokens: cache.total.tokens,
      worst: cache.worst ?? null,
    },
  }
}

/**
 * Инструментов в печати не больше стольких; остальные — одной строкой с числом
 * и суммой. Молчаливое усечение читалось бы как «это весь список».
 */
const TOOL_LIMIT = 15

/**
 * Моделей и проектов в печати не больше стольких (8.3); остальные — одной
 * строкой с числом и суммой, как инструменты. Клетки проекта печатаются все:
 * на живой машине их у проекта максимум семь. В `--json` едут все строки.
 */
const MODEL_LIMIT = 10
const PROJECT_LIMIT = 10

export function briefMarkdown(brief: AiBrief): string {
  const lines: string[] = [
    t('brief.title'),
    '',
    t('brief.period', { from: isoDate(brief.range.from), to: isoDate(brief.range.to - 1) }),
  ]

  if (brief.totals === null) {
    lines.push('', t('brief.empty'))
    return `${lines.join('\n')}\n`
  }

  lines.push('', t('brief.task'), '', t('brief.rulesTitle'), '')
  for (const rule of [
    'ruleTotal',
    'ruleRecurring',
    'ruleMarginal',
    'ruleDeferred',
    'ruleCache',
    'ruleModels',
    'ruleSpeed',
    'ruleApprox',
  ] as const) {
    lines.push(`- ${t(`brief.${rule}`)}`)
  }

  lines.push('', t('brief.totalsTitle'), '')
  lines.push(
    t('brief.totalsLine', {
      total: brief.totals.total,
      requests: brief.totals.requests,
      sessions: brief.sessions,
    }),
  )
  lines.push(
    t('brief.kindsLine', {
      input: brief.totals.input,
      output: brief.totals.output,
      cacheWrite: brief.totals.cacheWrite,
      cacheRead: brief.totals.cacheRead,
    }),
  )
  if (brief.approximate) lines.push(t('brief.totalsApprox'))

  const split = brief.split
  lines.push('', t('brief.splitTitle'), '')
  lines.push(
    t('brief.splitLine', {
      recurring: split.recurring,
      total: split.total,
      percent: split.total > 0 ? Math.round((split.recurring / split.total) * 100) : 0,
      firstRead: split.firstRead,
      reread: split.recurring - split.firstRead,
      marginal: split.marginal,
    }),
  )

  if (brief.categories.length > 0) {
    lines.push('', t('brief.categoriesTitle'), '')
    for (const row of brief.categories) {
      lines.push(
        t('brief.categoryLine', {
          name: categoryLabel(row.category, row.basis),
          tokens: row.tokens,
          perSession: row.perSession,
          usage: categoryUsage(row),
        }),
      )
    }
  }

  const servers = brief.categories.find((row) => row.category === 'mcpTools')?.sources ?? []
  if (servers.length > 0) {
    lines.push('', t('brief.serversTitle'), '')
    for (const server of servers) {
      lines.push(
        t('brief.serverLine', {
          name: server.source,
          tokens: server.tokens,
          perSession: server.perSession,
          loaded: server.loaded,
          used: server.used,
          calls: server.calls,
        }),
      )
    }
  }

  lines.push('', t('brief.adviceTitle'), '')
  if (brief.advice.length === 0) lines.push(t('brief.adviceNone'))
  for (const saving of brief.advice) {
    lines.push(
      t('brief.adviceLine', {
        name: saving.source,
        sessions: saving.sessions,
        tokens: saving.tokens,
        perSession: saving.perSession,
        projects: saving.projects.join(', '),
        eager:
          saving.unmeasured > 0 ? t('brief.adviceEager', { count: saving.unmeasured }) : '',
      }),
    )
  }

  if (brief.tools.length > 0) {
    lines.push('', t('brief.toolsTitle'), '')
    for (const tool of brief.tools.slice(0, TOOL_LIMIT)) {
      lines.push(
        t('brief.toolLine', { name: toolRowLabel(tool.key), calls: tool.calls, tokens: tool.tokens }),
      )
    }
    const rest = brief.tools.slice(TOOL_LIMIT)
    if (rest.length > 0) {
      lines.push(
        t('brief.toolsRest', {
          count: rest.length,
          tokens: rest.reduce((sum, tool) => sum + tool.tokens, 0),
        }),
      )
    }
  }

  if (brief.models.length > 0) lines.push(...modelsSection(brief))

  lines.push('', t('brief.cacheTitle'), '')
  if (!brief.cache.measurable) {
    lines.push(t('brief.cacheNone'))
  } else {
    lines.push(
      t('brief.cacheLine', {
        start: brief.cache.start.count,
        pause: brief.cache.pause.count,
        early: brief.cache.early.count,
        compact: brief.cache.compact.count,
        tokens: brief.cache.tokens,
      }),
    )
    if (brief.cache.ttlMs > 0) {
      lines.push(t('brief.cacheTtl', { minutes: Math.round(brief.cache.ttlMs / 60_000) }))
    }
    const worst = brief.cache.worst
    if (worst !== null && worst.pauseMs !== null) {
      lines.push(
        t('brief.cacheWorst', {
          minutes: Math.round(worst.pauseMs / 60_000),
          tokens: worst.tokens,
          project: worst.project,
        }),
      )
    }
  }

  return `${lines.join('\n')}\n`
}

/**
 * Хвост строки статьи: загружено против использованного.
 *
 * `used: null` — «нечем измерить», и это не ноль (см. `loaded.ts`): ноль был бы
 * поводом посоветовать выключить, а мы просто не умеем считать. У статей не из
 * штук (`loaded: null`) хвоста нет вовсе.
 */
function categoryUsage(row: LoadedCategory): string {
  if (row.loaded === null) return ''
  if (row.used === null) return t('brief.categoryUsageUnknown')
  return t('brief.categoryUsage', { loaded: row.loaded, used: row.used })
}

/**
 * Раздел «Модели и проекты» (8.3).
 *
 * Числа — сырые, как остальные токены файла; доли — в процентах до десятых от
 * итога периода (у модели) и от итога проекта (у клетки внутри проекта).
 * Секунды — `Math.round(ms / 100) / 10`. Восстановленные запросы названы
 * словами, а не знаком `≈`: файл читает модель, а не глаз, и слово несёт
 * причину.
 */
function modelsSection(brief: AiBrief): string[] {
  const period = brief.totals?.total ?? 0
  const lines = ['', t('brief.modelsTitle'), '']
  for (const cell of brief.models.slice(0, MODEL_LIMIT)) {
    lines.push(
      t('brief.modelLine', {
        name: cell.model,
        provider: cell.provider,
        tokens: cell.totals.total,
        percent: percent(cell.totals.total, period),
        requests: cell.totals.requests,
        inherited:
          cell.inherited > 0 ? t('brief.modelInherited', { tokens: cell.inherited }) : '',
        speed:
          cell.speed === undefined
            ? t('brief.modelSpeedFew', { min: SPEED.minRequests })
            : t('brief.modelSpeed', {
                p50: seconds(cell.speed.p50Ms),
                p90: seconds(cell.speed.p90Ms),
                pace: cell.speed.tokensPerSecond,
                count: cell.speed.requests,
              }),
      }),
    )
  }
  const modelsRest = brief.models.slice(MODEL_LIMIT)
  if (modelsRest.length > 0) {
    lines.push(
      t('brief.modelsRest', {
        count: modelsRest.length,
        tokens: modelsRest.reduce((sum, cell) => sum + cell.totals.total, 0),
      }),
    )
  }

  if (brief.projects.length === 0) return lines
  lines.push('', t('brief.projectsTitle'), '')
  for (const row of brief.projects.slice(0, PROJECT_LIMIT)) {
    lines.push(
      t('brief.projectLine', {
        name: projectRowLabel(row.project),
        tokens: row.totals.total,
        percent: percent(row.totals.total, period),
        requests: row.totals.requests,
        models: row.cells
          .map((cell) =>
            t('brief.projectModel', {
              model: cell.model,
              percent: percent(cell.totals.total, row.totals.total),
            }),
          )
          .join(', '),
      }),
    )
  }
  const projectsRest = brief.projects.slice(PROJECT_LIMIT)
  if (projectsRest.length > 0) {
    lines.push(
      t('brief.projectsRest', {
        count: projectsRest.length,
        tokens: projectsRest.reduce((sum, row) => sum + row.totals.total, 0),
      }),
    )
  }
  return lines
}

function percent(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'
}

/** Секунды до десятых из миллисекунд. */
function seconds(ms: number): number {
  return Math.round(ms / 100) / 10
}
