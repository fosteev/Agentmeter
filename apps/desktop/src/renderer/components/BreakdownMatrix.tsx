/**
 * Развёртка «проекты × модели» (8.2) — раздел 12 макета, строки 2101–2384;
 * скорость модели в повороте (8.4) — раздел 12б, строки 2427–2548.
 *
 * Три части: полоса периода с легендой моделей, таблица проектов с делением
 * полосы и полоса честности внизу; поворот «по моделям» — те же числа из того
 * же объекта, а не второй запрос: сходи окно в main ещё раз, и сумма по
 * проектам могла бы разойтись с суммой по моделям на глазах у человека.
 *
 * Всё, что видно числом, приехало посчитанным; здесь считаются только длины
 * полос против самой длинной (правило 3.0) и раздаются цвета: тон — провайдер,
 * ступень светлоты — модель, по полному списку моделей, чтобы модель из хвоста
 * легенды была того же цвета и в раскрытом проекте.
 *
 * Порядок полосы периода и легенды — модели, сгруппированные по провайдеру
 * (провайдеры — по своей самой крупной модели): перемешай тона в полосе, и
 * цвет перестанет кодировать провайдера. Поворот идёт чистым убыванием — там
 * каждая полоса своя и группировать нечего. Хвосты приезжают свёрнутыми со
 * своим числом; сегмент хвоста в полосе — «--tx3», ничей.
 */
import { useState } from 'react'
import type { MatrixModelLine, MatrixScreen } from '@agentmeter/ipc'
import { MATRIX_GRID, MatrixProjectRow } from './MatrixProjectRow.tsx'
import { ModelStrip, type StripSegment } from './ModelStrip.tsx'
import { mono } from './SpendCategoryTable.tsx'
import { formatCount, formatPercent, formatRate, formatSeconds, formatTokens, t } from '../format.ts'
import { modelTone } from '../paint.ts'

/**
 * Строка поворота (8.4, строки 2427–2531): модель, ответ, темп, расход. Столбцы
 * скорости — фиксированной ширины, чтобы числа соседних моделей стояли
 * разряд под разрядом; расход — справа, как в повороте 8.2.
 */
const PIVOT_GRID = 'minmax(0,1fr) 72px 48px 132px'

export interface BreakdownMatrixProps {
  matrix: MatrixScreen
  pivot: 'projects' | 'models'
}

export function BreakdownMatrix({ matrix, pivot }: BreakdownMatrixProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const colors = modelColors(matrix.models)
  const color = (line: { provider: string; model: string }): string =>
    colors.get(`${line.provider} ${line.model}`) ?? 'var(--tx3)'
  const named = matrix.models.slice(0, matrix.models.length - (matrix.modelTail?.count ?? 0))
  const legend = stripOrder(named)

  const toggle = (project: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })
  }

  return (
    <>
      {pivot === 'projects' ? (
        <>
          <div
            data-matrix-strip
            style={{
              padding: '18px 24px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              borderBottom: '1px solid var(--line)',
              background: 'var(--s1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span
                style={{ ...mono(10), letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--tx3)' }}
              >
                {t('matrix.stripTitle')}
              </span>
              <span data-matrix-total style={{ ...mono(13), fontWeight: 600 }}>
                {formatTokens(matrix.totals.tokens)}
              </span>
            </div>
            <ModelStrip height={26} segments={periodSegments(legend, matrix.modelTail, color)} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {legend.map((line) => (
                <LegendItem
                  key={`${line.provider} ${line.model}`}
                  name={line.model}
                  square={color(line)}
                  tokens={line.tokens.confidence === 'exact' ? '' : '≈'}
                  value={line.tokens.value}
                  caveat={line.tokens.caveat}
                  meta={legendMeta(line)}
                />
              ))}
              {matrix.modelTail === undefined ? null : (
                <LegendItem
                  name={t('matrix.modelTail', { count: matrix.modelTail.count })}
                  square="var(--tx3)"
                  tokens={matrix.modelTail.tokens.confidence === 'exact' ? '' : '≈'}
                  value={matrix.modelTail.tokens.value}
                  caveat={matrix.modelTail.tokens.caveat}
                  meta={legendMeta(matrix.modelTail)}
                />
              )}
            </div>
          </div>

          <div
            data-matrix-table
            style={{ padding: '18px 24px 20px', display: 'flex', flexDirection: 'column', gap: 13 }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: MATRIX_GRID,
                gap: 12,
                ...mono(10),
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: 'var(--tx3)',
                paddingBottom: 2,
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span>{t('matrix.columnProject')}</span>
              <span>{t('matrix.columnSpend')}</span>
              <span style={{ textAlign: 'right' }}>{t('matrix.columnRequests')}</span>
              <span style={{ textAlign: 'right' }}>{t('matrix.columnAverage')}</span>
              <span style={{ textAlign: 'right' }}>{t('matrix.columnTotal')}</span>
              <span style={{ textAlign: 'right' }}>{t('matrix.columnShare')}</span>
            </div>
            {matrix.rows.map((row) => (
              <MatrixProjectRow
                key={row.project}
                row={row}
                maxShare={matrix.rows[0]?.share ?? 0}
                colors={colors}
                open={open.has(row.project)}
                onToggle={toggle}
              />
            ))}
            {matrix.rowTail === undefined ? null : (
              <div
                data-matrix-tail
                style={{
                  display: 'grid',
                  gridTemplateColumns: MATRIX_GRID,
                  gap: 12,
                  alignItems: 'center',
                  opacity: 0.72,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ ...mono(10), color: 'var(--tx3)', width: 8, flexShrink: 0 }}>›</span>
                  <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
                    {t('matrix.rowTail', { count: matrix.rowTail.count })}
                  </span>
                </div>
                <ModelStrip
                  height={12}
                  width={
                    matrix.rows[0]?.share ? matrix.rowTail.share / matrix.rows[0].share : 0
                  }
                  segments={[{ key: 'tail', color: 'var(--tx3)', share: 1 }]}
                />
                <span style={{ ...mono(12, 'right'), color: 'var(--tx3)' }}>
                  {formatCount(matrix.rowTail.requests)}
                </span>
                <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
                  {formatTokens(matrix.rowTail.average)}
                </span>
                <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>
                  {formatTokens(matrix.rowTail.tokens)}
                </span>
                <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
                  {formatPercent(matrix.rowTail.share)}
                </span>
              </div>
            )}
            <div
              data-matrix-totals
              style={{
                display: 'grid',
                gridTemplateColumns: MATRIX_GRID,
                gap: 12,
                alignItems: 'center',
                borderTop: '1px solid var(--line)',
                paddingTop: 12,
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('matrix.total')}</span>
              <span />
              <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>
                {formatCount(matrix.totals.requests)}
              </span>
              <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
                {formatTokens(matrix.totals.average)}
              </span>
              <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
                {formatTokens(matrix.totals.tokens)}
              </span>
              <span style={{ ...mono(11, 'right'), color: 'var(--tx2)' }}>
                {formatPercent(1, 0)}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div
          data-matrix-pivot
          style={{ padding: '16px 20px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div
            data-matrix-pivot-head
            style={{
              display: 'grid',
              gridTemplateColumns: PIVOT_GRID,
              gap: 12,
              ...mono(10),
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              color: 'var(--tx3)',
              paddingBottom: 2,
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span />
            <span style={{ textAlign: 'right' }}>{t('matrix.columnResponse')}</span>
            <span style={{ textAlign: 'right' }}>{t('matrix.columnPace')}</span>
            <span />
          </div>
          {named.map((line) => (
            <div
              key={`${line.provider} ${line.model}`}
              data-matrix-pivot-model={line.model}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div
                style={{ display: 'grid', gridTemplateColumns: PIVOT_GRID, gap: 12, alignItems: 'start' }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, paddingTop: 1 }}
                >
                  <div
                    style={{ width: 7, height: 7, borderRadius: 2, background: color(line), flexShrink: 0 }}
                  />
                  <span style={{ ...mono(11.5) }}>{line.model}</span>
                </div>
                <SpeedCells speed={line.speed} />
                <span style={{ ...mono(12, 'right'), fontWeight: 600 }} title={line.tokens.caveat}>
                  {t('matrix.pivotValue', {
                    tokens: `${line.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(line.tokens.value)}`,
                    percent: formatPercent(line.share),
                  })}
                </span>
              </div>
              <ModelStrip
                height={12}
                width={named[0]?.share ? line.share / named[0].share : 0}
                segments={pivotSegments(line, color(line))}
              />
              <div style={{ ...mono(10.5), color: 'var(--tx3)' }}>{pivotCaption(line)}</div>
            </div>
          ))}
          {matrix.modelTail === undefined ? null : (
            <div
              data-matrix-pivot-tail
              style={{
                display: 'grid',
                gridTemplateColumns: PIVOT_GRID,
                gap: 12,
                alignItems: 'baseline',
                opacity: 0.72,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--tx3)' }} />
                <span style={{ ...mono(11.5), color: 'var(--tx2)' }}>
                  {t('matrix.modelTail', { count: matrix.modelTail.count })}
                </span>
              </div>
              {/* У хвоста одной модели нет — и скорости тоже: медиана по смеси
                  моделей не была бы скоростью ни одной из них. */}
              <span />
              <span />
              <span style={{ ...mono(12, 'right'), fontWeight: 600 }} title={matrix.modelTail.tokens.caveat}>
                {t('matrix.pivotValue', {
                  tokens: `${matrix.modelTail.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(matrix.modelTail.tokens.value)}`,
                  percent: formatPercent(matrix.modelTail.share),
                })}
              </span>
            </div>
          )}
          <div
            data-matrix-speed-note
            style={{
              borderTop: '1px solid var(--line)',
              paddingTop: 12,
              fontSize: 11.5,
              color: 'var(--tx2)',
              lineHeight: 1.55,
            }}
          >
            {t('matrix.speedNote')}
          </div>
        </div>
      )}

      <HonestyStrip rows={matrix.rows} />
    </>
  )
}

/**
 * Два столбца скорости (8.4): медиана ответа с p90 мелко под ней и темп. Ниже
 * порога — одни слова на оба столбца: пустая ячейка читалась бы как «не
 * посчиталось», а медиана из двух запросов — как типичное.
 */
function SpeedCells({ speed }: { speed: MatrixModelLine['speed'] }) {
  if (speed === undefined)
    return (
      <span
        data-matrix-speed-few
        style={{ gridColumn: 'span 2', ...mono(11, 'right'), color: 'var(--tx3)' }}
      >
        {t('matrix.speedFew')}
      </span>
    )
  return (
    <>
      <div
        data-matrix-speed
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}
      >
        <span style={{ ...mono(12) }}>
          {t('matrix.speedSeconds', { value: formatSeconds(speed.p50Ms) })}
        </span>
        <span style={{ ...mono(10), color: 'var(--tx3)' }}>
          {t('matrix.speedP90', { value: formatSeconds(speed.p90Ms) })}
        </span>
      </div>
      <span data-matrix-pace style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>
        {formatRate(speed.tokensPerSecond)}
      </span>
    </>
  )
}

/**
 * Полоса честности (строки 2323–2335): два приближения экрана словами. Первое —
 * служебная модель заголовков и сводок, которой нет ни строкой (правило 20):
 * это отсутствие данных, а не ноль, и клетка с нулём заявила бы, что её
 * измерили. Второе — знак `≈` на строках моделей; его половина рисуется только
 * когда на экране есть хоть одна такая строка: объяснение знака, которого нет,
 * читалось бы как знак, который забыли нарисовать.
 */
function HonestyStrip({ rows }: { rows: MatrixScreen['rows'] }) {
  const shares = rows.map((row) => row.inheritedShare)
  const inherited = shares.some((value) => value > 0)
  return (
    <div
      data-matrix-honesty
      style={{
        borderTop: '1px solid var(--line)',
        background: 'var(--s1)',
        padding: '14px 24px',
        display: 'flex',
        gap: 24,
      }}
    >
      <HonestyItem sign="—" text={t('matrix.honestyMissing')} />
      {inherited ? (
        <HonestyItem
          sign="≈"
          text={t('matrix.honestyInherited', {
            range: `${formatPercent(Math.min(...shares)).slice(0, -1)}–${formatPercent(Math.max(...shares))}`,
          })}
        />
      ) : null}
    </div>
  )
}

function HonestyItem({ sign, text }: { sign: string; text: string }) {
  return (
    <div style={{ display: 'flex', gap: 9, flex: 1 }}>
      <span style={{ ...mono(12), color: 'var(--tx3)', flexShrink: 0 }}>{sign}</span>
      <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.55 }}>{text}</div>
    </div>
  )
}

function LegendItem({
  name,
  square,
  tokens,
  value,
  caveat,
  meta,
}: {
  name: string
  square: string
  tokens: string
  value: number
  caveat: string | undefined
  meta: string
}) {
  return (
    <div data-matrix-legend={name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <div style={{ width: 7, height: 7, borderRadius: 2, background: square, flexShrink: 0 }} />
        <span
          style={{ ...mono(11.5), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {name}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, paddingLeft: 14 }}>
        <span style={{ ...mono(12.5), fontWeight: 600 }} title={caveat}>
          {tokens}
          {formatTokens(value)}
        </span>
        <span style={{ ...mono(11), color: 'var(--tx3)', whiteSpace: 'nowrap' }}>{meta}</span>
      </div>
    </div>
  )
}

function legendMeta(line: { share: number; requests: number; average: number }): string {
  return t('matrix.legendLine', {
    percent: formatPercent(line.share),
    requests: formatCount(line.requests),
    average: formatTokens(line.average),
  })
}

/**
 * Цвет каждой модели периода — по полному списку, а не по легенде: модель из
 * хвоста легенды стоит клеткой в раскрытом проекте и обязана быть одного цвета
 * везде. Ступень — место модели среди моделей своего провайдера по расходу.
 */
function modelColors(models: MatrixModelLine[]): Map<string, string> {
  const steps = new Map<string, number>()
  const out = new Map<string, string>()
  for (const line of models) {
    const step = steps.get(line.provider) ?? 0
    steps.set(line.provider, step + 1)
    out.set(`${line.provider} ${line.model}`, modelTone(line.provider, step))
  }
  return out
}

/**
 * Порядок полосы периода: модели сгруппированы по провайдеру, провайдеры — по
 * своей самой крупной модели. Это не исключение из «сортировки по размеру», а
 * условие читаемости тона: перемешай тёплые и холодные сегменты — и цвет
 * перестанет кодировать провайдера.
 */
function stripOrder(named: MatrixModelLine[]): MatrixModelLine[] {
  const providers: string[] = []
  for (const line of named) {
    if (!providers.includes(line.provider)) providers.push(line.provider)
  }
  return providers.flatMap((provider) => named.filter((line) => line.provider === provider))
}

function periodSegments(
  legend: MatrixModelLine[],
  tail: MatrixScreen['modelTail'],
  color: (line: MatrixModelLine) => string,
): StripSegment[] {
  const segments = legend.map((line) => ({
    key: `${line.provider} ${line.model}`,
    color: color(line),
    share: line.share,
  }))
  if (tail !== undefined) segments.push({ key: 'tail', color: 'var(--tx3)', share: tail.share })
  return segments
}

function pivotSegments(line: MatrixModelLine, tone: string): StripSegment[] {
  const segments = (line.projects ?? []).map((segment) => ({
    key: segment.project === '' ? 'no-project' : segment.project,
    color: tone,
    share: segment.share,
  }))
  if (line.projectTail !== undefined)
    segments.push({ key: 'tail', color: tone, share: line.projectTail.share })
  return segments
}

/** «Wayfork 43% · troy 24% · … · хвост 2%» — подстановка приехавших долей. */
function pivotCaption(line: MatrixModelLine): string {
  const parts = (line.projects ?? []).map(
    (segment) => `${segment.label} ${formatPercent(segment.share, 0)}`,
  )
  if (line.projectTail !== undefined)
    parts.push(t('matrix.pivotTail', { percent: formatPercent(line.projectTail.share, 0) }))
  return parts.join(' · ')
}
