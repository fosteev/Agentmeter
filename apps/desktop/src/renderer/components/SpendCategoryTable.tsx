import type { SpendCategoryRow } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { hatch } from '../paint.ts'

/**
 * Левая колонка развёртки — что лежит в начале каждого промпта
 * (строки 1024–1040 макета).
 *
 * Сетка `1fr 90px 74px 84px` и все отступы — оттуда же. Ширина полосы под
 * названием считается здесь: это доля внутри своей диаграммы, у неё нет ни
 * текста рядом, ни второго потребителя (правило 3.0). А «2 из 9» и сами
 * токены приезжают готовыми — их видно числом.
 */
export interface SpendCategoryTableProps {
  rows: SpendCategoryRow[]
}

const GRID = '1fr 90px 74px 84px'

export function SpendCategoryTable({ rows }: SpendCategoryTableProps) {
  const maximum = Math.max(0, ...rows.map((row) => row.period.value))

  return (
    <div data-spend-categories style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {rows.map((row) => (
        <div
          key={row.key}
          data-spend-category={row.key}
          style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center' }}
          title={row.period.caveat}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            <span style={{ fontSize: 12.5 }}>
              {row.label}
              {row.loaded === null ? null : (
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'var(--tx3)' }}>
                  {' '}
                  {row.loaded}
                </span>
              )}
            </span>
            <div
              style={{ height: 8, borderRadius: 2, background: 'var(--s2)', overflow: 'hidden' }}
            >
              <div
                data-spend-category-fill={row.key}
                style={{
                  width: `${maximum === 0 ? 0 : (row.period.value / maximum) * 100}%`,
                  height: '100%',
                  background: hatch('var(--warn)'),
                }}
              />
            </div>
          </div>
          <span style={mono(12, 'right')}>
            {row.perSession.confidence === 'exact' ? '' : '≈'}
            {formatTokens(row.perSession.value)}
          </span>
          <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
            {row.used === null || row.loaded === null
              ? t('breakdown.unmeasurable')
              : t('breakdown.usedOf', { used: row.used, loaded: row.loaded })}
          </span>
          <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>
            {row.period.confidence === 'exact' ? '' : '≈'}
            {formatTokens(row.period.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function mono(size: number, align?: 'right'): React.CSSProperties {
  return {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: size,
    textAlign: align,
    fontVariantNumeric: 'tabular-nums',
  }
}

export const CATEGORY_GRID = GRID
