import type { BreakdownReport, MatrixCell, SpendMatrix } from '@agentmeter/core'
import { formatDecimal, formatPercent, projectRowLabel, t, toolRowLabel } from '@agentmeter/core'
import { formatNumber, formatTokens, table } from '../format.ts'

/** Оси, которые строит `breakdownReport` (4.2). Шестая — `project-model` — живёт отдельно. */
export type ReportAxis = 'tool' | 'server' | 'skill' | 'agent' | 'model'
export type BreakdownAxis = ReportAxis | 'project-model'

/**
 * `session` — отчёт собран за сессию, а не за период. Ось моделей там прежняя
 * (`BreakdownReport.model`), без скорости: у `RequestScope` нет `sessionId`, и
 * скорость — свойство периода. Строка под таблицей говорит об этом словами,
 * чтобы отсутствие колонок не читалось как «не измерено».
 */
export function renderBreakdown(
  report: BreakdownReport,
  axis: ReportAxis,
  locale: string,
  session = false,
): string {
  if (report.emptyIndex) return t('cli.emptyIndex')
  if (report.emptyScope) return t('cli.emptyRange')
  const text = renderAxis(report, axis, locale)
  return session && axis === 'model' ? `${text}\n\n${t('cli.speedNeedsRange')}` : text
}

function renderAxis(report: BreakdownReport, axis: ReportAxis, locale: string): string {
  if (axis === 'tool') {
    return table(
      [
        { header: t('cli.columnTool'), width: 28 },
        { header: t('cli.columnMeasured'), width: 11, align: 'right' },
        { header: t('cli.columnSplit'), width: 11, align: 'right' },
        { header: t('cli.columnUnknown'), width: 11, align: 'right' },
        { header: t('cli.columnCalls'), width: 7, align: 'right' },
      ],
      report.tool.map((row) => [
        toolRowLabel(row.key),
        formatTokens(row.tokens.measured, locale),
        formatTokens(row.tokens.split, locale),
        formatTokens(row.tokens.unknown, locale),
        formatNumber(row.calls.measured + row.calls.split + row.calls.unknown, locale),
      ]),
    )
  }
  if (axis === 'server') {
    return table(
      [
        { header: t('cli.columnServer'), width: 40 },
        { header: t('cli.columnTokens'), width: 14, align: 'right' },
        { header: t('cli.columnCalls'), width: 10, align: 'right' },
      ],
      report.server.map((row) => [
        row.key,
        formatTokens(row.tokens, locale),
        formatNumber(row.calls, locale),
      ]),
    )
  }
  return table(
    [
      { header: axisTitle(axis), width: 40 },
      { header: t('cli.columnTokens'), width: 14, align: 'right' },
      { header: t('cli.columnRequests'), width: 10, align: 'right' },
    ],
    report[axis].map((row) => [
      row.key,
      formatTokens(row.totals.total, locale),
      formatNumber(row.totals.requests, locale),
    ]),
  )
}

function axisTitle(axis: Exclude<ReportAxis, 'tool' | 'server'>): string {
  if (axis === 'skill') return t('cli.columnSkill')
  if (axis === 'agent') return t('cli.columnAgent')
  return t('cli.columnModel')
}

/**
 * `--by project-model` (8.3): строка проекта и под ней его клетки.
 *
 * Все числа — из `spendMatrix`, ничего не считается заново. Хвосты не
 * сворачиваются: окно режет их ради ширины, а у терминала ширины нет, и сумма
 * напечатанных клеток обязана быть итогом. `≈` стоит перед токенами клетки с
 * `inherited > 0` и никогда у строки проекта или итога — длина измерена,
 * деление по моделям нет (то же правило, что в окне).
 */
export function renderProjectModel(matrix: SpendMatrix, locale: string): string {
  if (matrix.emptyIndex) return t('cli.emptyIndex')
  if (matrix.emptyScope) return t('cli.emptyRange')
  const rows: string[][] = []
  let approximate = false
  for (const row of matrix.rows) {
    rows.push([
      projectRowLabel(row.project),
      '',
      formatTokens(row.totals.total, locale),
      formatNumber(row.totals.requests, locale),
      share(row.totals.total, matrix.totals.total, locale),
    ])
    for (const cell of row.cells) {
      approximate ||= cell.inherited > 0
      rows.push([
        `  ${cell.model}`,
        cell.provider,
        cellTokens(cell, locale),
        formatNumber(cell.totals.requests, locale),
        share(cell.totals.total, row.totals.total, locale),
      ])
    }
  }
  rows.push([
    t('cli.rowTotal'),
    '',
    formatTokens(matrix.totals.total, locale),
    formatNumber(matrix.totals.requests, locale),
    '',
  ])
  const lines = [
    table(
      [
        { header: t('cli.columnProjectModel'), width: 40 },
        { header: t('cli.columnProvider'), width: 10 },
        { header: t('cli.columnTokens'), width: 14, align: 'right' },
        { header: t('cli.columnRequests'), width: 10, align: 'right' },
        { header: t('cli.columnShare'), width: 8, align: 'right' },
      ],
      rows,
    ),
  ]
  if (approximate) lines.push('', t('matrix.inheritedCaveat'))
  return lines.join('\n')
}

/**
 * `--by model` за период (8.3): маргиналь матрицы со скоростью.
 *
 * Строки — `SpendMatrix.models`, а не `BreakdownReport.model`: у той нет
 * провайдера, а ключ скорости — пара «провайдер модель». Модель без `speed`
 * получает в колонке ответа слова «мало данных», две другие пусты: нуль или
 * пустая строка читались бы как измеренное «мгновенно».
 */
export function renderModels(matrix: SpendMatrix, locale: string): string {
  if (matrix.emptyIndex) return t('cli.emptyIndex')
  if (matrix.emptyScope) return t('cli.emptyRange')
  const seconds = (ms: number) => formatDecimal(ms / 1000, locale)
  const lines = [
    table(
      [
        { header: t('cli.columnModel'), width: 40 },
        { header: t('cli.columnProvider'), width: 10 },
        { header: t('cli.columnTokens'), width: 14, align: 'right' },
        { header: t('cli.columnRequests'), width: 10, align: 'right' },
        { header: t('cli.columnResponse'), align: 'right' },
        { header: t('cli.columnP90'), align: 'right' },
        { header: t('matrix.columnPace'), align: 'right' },
      ],
      matrix.models.map((cell) => [
        cell.model,
        cell.provider,
        cellTokens(cell, locale),
        formatNumber(cell.totals.requests, locale),
        ...(cell.speed === undefined
          ? [t('matrix.speedFew'), '', '']
          : [
              seconds(cell.speed.p50Ms),
              seconds(cell.speed.p90Ms),
              formatDecimal(cell.speed.tokensPerSecond, locale),
            ]),
      ]),
    ),
  ]
  if (matrix.models.some((cell) => cell.inherited > 0)) lines.push('', t('matrix.inheritedCaveat'))
  lines.push('', t('matrix.speedNote'))
  return lines.join('\n')
}

function cellTokens(cell: MatrixCell, locale: string): string {
  return `${cell.inherited > 0 ? '≈' : ''}${formatTokens(cell.totals.total, locale)}`
}

function share(value: number, total: number, locale: string): string {
  return total === 0 ? '—' : formatPercent(value / total, locale)
}
