/**
 * Развёртка «проекты × модели» (8.2) — украшение матрицы ядра под раздел 12.
 *
 * Раскладка по двум ключам сделана в ядре (`spendMatrix`, 8.1) и здесь не
 * повторяется: этот файл только переводит готовые клетки в числа, которые
 * видно текстом, — доли, средние, свёрнутые хвосты (правило 3.0). Второго
 * счёта расхода тут нет ни в одном месте: каждое число — деление уже
 * посчитанных ядром сумм друг на друга.
 *
 * Хвосты сворачиваются по размеру, а не по интересности, — грабли пойманы на
 * самом макете, где показательный `cpgu-frontend` вытеснил вдвое больший
 * `Projects` из таблицы, заявлявшей сортировку по расходу. И у каждого хвоста
 * есть своё число: молчаливая обрезка читается как «там ничего».
 */
import { projectRowLabel, t, type MatrixCell, type SpendMatrix } from '@agentmeter/core'
import type { MatrixModelLine, MatrixProjectLine, MatrixScreen, Measured } from '@agentmeter/ipc'

/**
 * Ниже какой доли периода проект уходит в хвост. Доля, а не абсолют, — по тому
 * же доводу, что у ленты: таблица одинаково нужна на дне в 340M и в 3M.
 */
const ROW_FOLD_SHARE = 0.001
/** Сколько строк проектов показываем всегда, даже если порог свернул бы больше. */
const ROW_KEEP = 5
/** Хвост проектов из одной строки места не экономит — такой не сворачиваем. */
const ROW_MIN_FOLDED = 2
/**
 * Ниже какой доли периода модель уходит в хвост легенды. Здесь сворачивается и
 * одна строка — довод не место, а честность: сегмент в 0.01% полосы не видно,
 * а отличимых ступеней светлоты внутри тона конечное число.
 */
const MODEL_FOLD_SHARE = 0.01
/** Сколько проектов повёрнутая полоса называет поимённо; остальные — хвост. */
const PIVOT_KEEP = 5

export function toMatrixScreen(matrix: SpendMatrix): MatrixScreen {
  const period = matrix.totals.total

  // Модели — все, по убыванию (ядро уже отсортировало): окну нужен полный
  // список под ступени светлоты, легенда режет его счётом из `modelTail`.
  // Хотя бы одна модель называется всегда: легенда из одного хвоста читалась
  // бы как «моделей не было» на дне, где они были.
  const named = Math.max(
    1,
    matrix.models.filter((cell) => share(cell.totals.total, period) >= MODEL_FOLD_SHARE).length,
  )
  const models = matrix.models.map((cell, index) => ({
    ...toModelLine(cell, period),
    ...(index < named ? pivot(matrix, cell) : {}),
  }))
  const foldedModels = matrix.models.slice(named)

  const shownRows = matrix.rows.filter(
    (row, index) => index < ROW_KEEP || share(row.totals.total, period) >= ROW_FOLD_SHARE,
  )
  const foldedRows = matrix.rows.slice(shownRows.length)
  const folded = foldedRows.length >= ROW_MIN_FOLDED

  return {
    models,
    ...(foldedModels.length === 0 ? {} : { modelTail: modelTail(foldedModels, period) }),
    rows: (folded ? shownRows : matrix.rows).map((row) => toProjectLine(row, period)),
    ...(folded ? { rowTail: rowTail(foldedRows, period) } : {}),
    totals: {
      tokens: period,
      requests: matrix.totals.requests,
      average: average(period, matrix.totals.requests),
    },
    emptyIndex: matrix.emptyIndex,
    emptyScope: matrix.emptyScope,
  }
}

/**
 * Строка модели. `whole` — знаменатель доли: период у маргинали, расход проекта
 * у клетки; каждый посчитан здесь, выбирать окну остаётся между готовыми.
 */
function toModelLine(cell: MatrixCell, whole: number): MatrixModelLine {
  return {
    model: cell.model,
    provider: cell.provider,
    tokens: inheritedTokens(cell.totals.total, cell.inherited),
    requests: cell.totals.requests,
    average: average(cell.totals.total, cell.totals.requests),
    share: share(cell.totals.total, whole),
    // Скорость (8.4) — как её посчитало ядро, без пересчёта: медиана — число,
    // которое видно текстом, и второй её экземпляр однажды разошёлся бы с
    // CLI. Есть только у маргинали — у клетки проекта ядро её не кладёт.
    ...(cell.speed === undefined ? {} : { speed: { ...cell.speed } }),
  }
}

/**
 * Знак `≈` живёт на строке модели и только на ней: токены восстановленных
 * запросов измерены (разрыв цепочки даёт стоимость целиком, 1.3), а модель у
 * них взята у соседа — неточным является деление, не длина.
 */
function inheritedTokens(total: number, inherited: number): Measured {
  return inherited > 0
    ? { value: total, confidence: 'reconstructed', caveat: t('matrix.inheritedCaveat') }
    : { value: total, confidence: 'exact' }
}

function toProjectLine(row: SpendMatrix['rows'][number], period: number): MatrixProjectLine {
  return {
    project: row.project,
    label: projectRowLabel(row.project),
    tokens: row.totals.total,
    requests: row.totals.requests,
    average: average(row.totals.total, row.totals.requests),
    share: share(row.totals.total, period),
    cells: row.cells.map((cell) => toModelLine(cell, row.totals.total)),
    inheritedShare: share(
      row.cells.reduce((sum, cell) => sum + cell.inherited, 0),
      row.totals.total,
    ),
  }
}

/**
 * Поворот «по моделям» — из того же объекта матрицы, не вторым запросом:
 * клетки строк, собранные поперёк, и потому сумма сегментов равна маргинали
 * модели по построению. Доли — от расхода модели.
 */
function pivot(
  matrix: SpendMatrix,
  cell: MatrixCell,
): Pick<MatrixModelLine, 'projects' | 'projectTail'> {
  const segments = matrix.rows
    .flatMap((row) =>
      row.cells
        .filter((own) => own.provider === cell.provider && own.model === cell.model)
        .map((own) => ({
          project: row.project,
          label: projectRowLabel(row.project),
          share: share(own.totals.total, cell.totals.total),
        })),
    )
    .sort((left, right) => right.share - left.share || left.project.localeCompare(right.project))
  const tail = segments.slice(PIVOT_KEEP)
  if (tail.length < 2) return { projects: segments }
  return {
    projects: segments.slice(0, PIVOT_KEEP),
    projectTail: {
      count: tail.length,
      share: tail.reduce((sum, segment) => sum + segment.share, 0),
    },
  }
}

function modelTail(cells: MatrixCell[], period: number): NonNullable<MatrixScreen['modelTail']> {
  const total = cells.reduce((sum, cell) => sum + cell.totals.total, 0)
  const requests = cells.reduce((sum, cell) => sum + cell.totals.requests, 0)
  return {
    count: cells.length,
    requests,
    average: average(total, requests),
    tokens: inheritedTokens(
      total,
      cells.reduce((sum, cell) => sum + cell.inherited, 0),
    ),
    share: share(total, period),
  }
}

function rowTail(
  rows: SpendMatrix['rows'],
  period: number,
): NonNullable<MatrixScreen['rowTail']> {
  const total = rows.reduce((sum, row) => sum + row.totals.total, 0)
  const requests = rows.reduce((sum, row) => sum + row.totals.requests, 0)
  return {
    count: rows.length,
    requests,
    average: average(total, requests),
    tokens: total,
    share: share(total, period),
  }
}

function average(total: number, requests: number): number {
  return requests === 0 ? 0 : Math.round(total / requests)
}

function share(value: number, whole: number): number {
  return whole === 0 ? 0 : value / whole
}
