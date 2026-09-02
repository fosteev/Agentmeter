/**
 * Строка проекта в развёртке «проекты × модели» (8.2) — строки 2142–2214
 * макета: свёрнутая строка и она же раскрытая до моделей.
 *
 * Длина полосы — размер проекта против самого крупного, деление — модели
 * внутри; обе доли приезжают числами, окно только переводит их в ширину
 * (правило 3.0). Точки у имени кодируют **состав**, а не количество, — потому
 * они и не спорят с полосой: у проекта в 0.4% периода деление полосы не
 * разглядеть честно, и читаемость дают точки с раскрытием, а не минимальная
 * ширина сегмента.
 *
 * Знак `≈` стоит на строках моделей и не стоит на итоге проекта: длина
 * измерена, деление — нет (восстановленные запросы наследуют модель соседа).
 * Сноска про это рисуется только там, где такие запросы есть.
 */
import type { MatrixProjectLine } from '@agentmeter/ipc'
import { ModelStrip } from './ModelStrip.tsx'
import { mono } from './SpendCategoryTable.tsx'
import { formatCount, formatPercent, formatTokens, t } from '../format.ts'

/** Сетка таблицы проектов — строка 2138 макета, одна на шапку, строки и итог. */
export const MATRIX_GRID = '206px 1fr 84px 74px 92px 52px'

export interface MatrixProjectRowProps {
  row: MatrixProjectLine
  /** Доля самой длинной строки таблицы — знаменатель длины полосы. */
  maxShare: number
  /** Цвет модели по ключу «провайдер модель» — раздан один раз на весь экран. */
  colors: ReadonlyMap<string, string>
  open: boolean
  onToggle: (project: string) => void
}

export function MatrixProjectRow({ row, maxShare, colors, open, onToggle }: MatrixProjectRowProps) {
  const color = (cell: { provider: string; model: string }): string =>
    colors.get(`${cell.provider} ${cell.model}`) ?? 'var(--tx3)'

  const header = (
    <div
      data-matrix-row={row.project}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => onToggle(row.project)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onToggle(row.project)
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: MATRIX_GRID,
        gap: 12,
        alignItems: 'center',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          style={{ ...mono(10), color: open ? 'var(--tx2)' : 'var(--tx3)', width: 8, flexShrink: 0 }}
        >
          {open ? '⌄' : '›'}
        </span>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: open ? 500 : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.label}
        </span>
        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
          {row.cells.map((cell) => (
            <div
              key={`${cell.provider} ${cell.model}`}
              title={cell.model}
              style={{ width: 6, height: 6, borderRadius: '50%', background: color(cell) }}
            />
          ))}
        </div>
      </div>
      <ModelStrip
        height={12}
        width={maxShare === 0 ? 0 : row.share / maxShare}
        segments={row.cells.map((cell) => ({
          key: `${cell.provider} ${cell.model}`,
          color: color(cell),
          share: cell.share,
        }))}
      />
      <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>{formatCount(row.requests)}</span>
      <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>{formatTokens(row.average)}</span>
      <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>{formatTokens(row.tokens)}</span>
      <span style={{ ...mono(11, 'right'), color: 'var(--tx2)' }}>
        {formatPercent(row.share)}
      </span>
    </div>
  )

  if (!open) return header
  return (
    <div
      data-matrix-open={row.project}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '10px 12px',
        margin: '0 -12px',
        borderRadius: 6,
        background: 'var(--s1)',
      }}
    >
      {header}
      {row.cells.map((cell) => (
        <div
          key={`${cell.provider} ${cell.model}`}
          data-matrix-cell={cell.model}
          style={{
            display: 'grid',
            gridTemplateColumns: MATRIX_GRID,
            gap: 12,
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 20, minWidth: 0 }}>
            <div
              style={{ width: 7, height: 7, borderRadius: 2, background: color(cell), flexShrink: 0 }}
            />
            <span
              style={{
                ...mono(11.5),
                color: 'var(--tx2)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {cell.model}
            </span>
          </div>
          {/* Знаменатель раскрытой полосы — проект, не самый крупный сосед:
              раскрытие отвечает «из чего состоит эта строка», и 90% здесь —
              те же 90%, что числом в колонке доли (строка 2190 макета). */}
          <ModelStrip
            height={8}
            width={cell.share}
            segments={[{ key: cell.model, color: color(cell), share: 1 }]}
          />
          <span style={{ ...mono(11.5, 'right'), color: 'var(--tx2)' }}>
            {formatCount(cell.requests)}
          </span>
          <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
            {formatTokens(cell.average)}
          </span>
          <span style={{ ...mono(11.5, 'right') }} title={cell.tokens.caveat}>
            {cell.tokens.confidence === 'exact' ? '' : '≈'}
            {formatTokens(cell.tokens.value)}
          </span>
          <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
            {formatPercent(cell.share, 0)}
          </span>
        </div>
      ))}
      {row.inheritedShare > 0 ? (
        <div
          data-matrix-note={row.project}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            paddingLeft: 20,
            paddingTop: 2,
            borderTop: '1px solid var(--line)',
            marginTop: 2,
          }}
        >
          <span style={{ ...mono(10.5), color: 'var(--tx3)', paddingTop: 2 }}>≈</span>
          <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5, maxWidth: 720 }}>
            {t('matrix.inheritedNote', { percent: formatPercent(row.inheritedShare, 2) })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
