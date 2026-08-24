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
import { savings, type Saving } from '../query/savings.ts'
import { spendSplit } from '../query/split.ts'
import { todayReport } from '../query/today.ts'
import type { DayRange, Totals } from '../query/types.ts'
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
  cache: BriefCache
}

export function aiBrief(db: Db, range: DayRange): AiBrief {
  const report = todayReport(db, range)
  const split = spendSplit(db, range)
  const cache = cacheRebuilds(db, { range })
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
