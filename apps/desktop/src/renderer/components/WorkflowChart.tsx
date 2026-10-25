import type { CSSProperties, ReactElement } from 'react'
import type { WorkflowCycleTip, WorkflowReworkBlock, WorkflowReworkDot } from '@agentmeter/ipc'
import { dateShort, formatMultiple, formatPercent, t } from '../format.ts'
import { MONO, roleName } from '../workflow.ts'

/**
 * График «По циклам» — строки 2629–2690 макета (раздел 13, 9.5).
 *
 * **Одна точка на полное окно**, поэтому ось X идёт не с первого цикла, а с
 * номера `size`: 12 циклов при окне 5 дают 8 точек. Окно, у которого точки нет
 * (все циклы исключены — исполнитель правил шеллом), не выпадает из оси: на его
 * месте подпись «точки нет · шеллом K из K», иначе разрыв по номерам читался бы
 * как потерянные данные. Линию через такой разрыв не тянем — интерполировать
 * несуществующее значение нечем.
 *
 * Окно ничего не считает: значения, числители и знаменатели приехали из main, а
 * здесь — только перевод долей в координаты (правило 13).
 *
 * Подсказка — по наведению **CSS-ом**, а не состоянием: тесты окна рендерят
 * статическую разметку (jsdom в проекте нет), и подсказка на `useState` осталась
 * бы непроверяемой. Все подсказки лежат в разметке, показывает одну правило в
 * `tokens.css` (`[data-wf-slot]:hover`).
 */

export const CHART = {
  width: 764,
  height: 220,
  left: 48,
  right: 756,
  top: 12,
  base: 172,
  /** Центры первого и последнего слота: отступ от краёв оси, как в макете. */
  first: 56,
  last: 736,
} as const

/** Верх оси: наименьшее «круглое» число процентов, в которое влезает всё нарисованное. */
const AXIS_TOPS = [20, 40, 60, 80, 100] as const

export function axisTop(maxShare: number): number {
  const percent = maxShare * 100
  return AXIS_TOPS.find((top) => percent <= top) ?? 100
}

/** Центры слотов по оси X: ровно по числу полных окон. Один слот встаёт в середину. */
export function slotCenters(slots: number): number[] {
  if (slots <= 0) return []
  if (slots === 1) return [(CHART.left + CHART.right) / 2]
  const step = (CHART.last - CHART.first) / (slots - 1)
  return Array.from({ length: slots }, (_, index) => CHART.first + index * step)
}

/** Доля → координата Y при выбранном верхе оси. */
export function shareY(share: number, top: number): number {
  return CHART.base - ((share * 100) / top) * (CHART.base - CHART.top)
}

/** Подпись окна-слота «№ n» и дата идут не под каждой точкой, если они не помещаются. */
const LABEL_GAP = 64
/** «шеллом K из N» над точкой занимает слот ≈170 px и не лезет в слот уже 96 px. */
const NOTE_GAP = 96

export interface WorkflowChartProps {
  rework: WorkflowReworkBlock
  cycles: WorkflowCycleTip[]
}

const caps = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--tx3)',
} as const

export function WorkflowChart({ rework, cycles }: WorkflowChartProps) {
  const { size, count, points, target } = rework
  const slots = Math.max(0, count - size + 1)
  const centers = slotCenters(slots)
  const step = slots > 1 ? centers[1]! - centers[0]! : CHART.right - CHART.left
  const maxShare = Math.max(target ?? 0, ...points.map((point) => point.value))
  const top = axisTop(maxShare)
  const byN = new Map<number, WorkflowReworkDot>(points.map((point) => [point.n, point]))
  const labelEvery = Math.max(1, Math.ceil(LABEL_GAP / step))
  const withNotes = step >= NOTE_GAP

  const ticks = [0, 1, 2, 3, 4].map((index) => ({
    y: CHART.base - index * ((CHART.base - CHART.top) / 4),
    label: index === 0 ? '0' : `${(top * index) / 4}%`,
  }))

  // Отрезки линии — только между соседними номерами: пропуск окна разрывает линию.
  const runs: Array<Array<{ x: number; y: number }>> = []
  let previous = -1
  for (const point of points) {
    const slot = point.n - size
    const spot = { x: centers[slot]!, y: shareY(point.value, top) }
    if (point.n === previous + 1 && runs.length > 0) runs[runs.length - 1]!.push(spot)
    else runs.push([spot])
    previous = point.n
  }
  const lastN = points.length === 0 ? -1 : points[points.length - 1]!.n

  return (
    <div
      data-workflow-chart
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={caps}>{t('workflow.chartTitle')}</span>
        {target === null ? null : (
          <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--tx2)' }}>
            {t('workflow.chartTarget')}
          </span>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          width="100%"
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          <g style={{ fontFamily: MONO, fontSize: 10, fill: 'var(--tx3)' }}>
            {ticks.map((tick) => (
              <text key={tick.label} x={CHART.left - 8} y={tick.y + 3} textAnchor="end">
                {tick.label}
              </text>
            ))}
          </g>
          {ticks.map((tick, index) => (
            <line
              key={tick.label}
              x1={CHART.left}
              y1={tick.y}
              x2={CHART.right}
              y2={tick.y}
              style={{ stroke: 'var(--line)', strokeWidth: 1, opacity: index === 0 ? 1 : 0.5 }}
            />
          ))}

          {target === null ? null : (
            <g data-workflow-target>
              <line
                x1={CHART.left}
                y1={shareY(target, top)}
                x2={CHART.right}
                y2={shareY(target, top)}
                style={{ stroke: 'var(--tx3)', strokeWidth: 1, strokeDasharray: '4 4' }}
              />
              <text
                x={CHART.left + 12}
                y={shareY(target, top) - 6}
                style={{ fontFamily: MONO, fontSize: 10, fill: 'var(--tx3)' }}
              >
                {t('workflow.targetLabel', { pct: formatPercent(target, 0) })}
              </text>
            </g>
          )}

          {centers.map((x, slot) => {
            const n = size + slot
            if (byN.has(n)) return null
            return (
              <g key={`none-${n}`} data-workflow-nopoint={n}>
                <line
                  x1={x}
                  y1={CHART.base}
                  x2={x}
                  y2={CHART.base - 24}
                  style={{ stroke: 'var(--tx3)', strokeWidth: 1, strokeDasharray: '2 3' }}
                />
                {withNotes ? (
                  <g
                    style={{ fontFamily: MONO, fontSize: 10, fill: 'var(--tx3)' }}
                    textAnchor="middle"
                  >
                    <text x={x} y={CHART.base - 44}>
                      {t('workflow.noPoint')}
                    </text>
                    <text x={x} y={CHART.base - 30}>
                      {t('workflow.shellOf', { k: size, n: size })}
                    </text>
                  </g>
                ) : null}
              </g>
            )
          })}

          {runs.map((run, index) =>
            run.length < 2 ? null : (
              <polyline
                key={`run-${index}`}
                points={run.map((spot) => `${round(spot.x)},${round(spot.y)}`).join(' ')}
                style={{
                  fill: 'none',
                  stroke: 'var(--tx)',
                  strokeWidth: 1.5,
                  strokeLinejoin: 'round',
                }}
              />
            ),
          )}
          {points.map((point) => {
            const x = centers[point.n - size]!
            const y = shareY(point.value, top)
            const last = point.n === lastN
            return (
              <circle
                key={point.n}
                data-workflow-point={point.n}
                cx={round(x)}
                cy={round(y)}
                r={last ? 4.5 : 3.5}
                style={{
                  fill: 'var(--tx)',
                  ...(last ? { stroke: 'var(--bg)', strokeWidth: 2 } : {}),
                }}
              />
            )
          })}

          {withNotes ? (
            <g style={{ fontFamily: MONO, fontSize: 10, fill: 'var(--tx2)' }} textAnchor="middle">
              {points
                .filter((point) => point.unseen > 0)
                .map((point) => {
                  const y = shareY(point.value, top)
                  return (
                    <text
                      key={point.n}
                      data-workflow-unseen={point.n}
                      x={centers[point.n - size]!}
                      // Над точкой, а у самого верха оси — под ней: выше рамки места нет.
                      y={y - 14 < CHART.top ? y + 20 : y - 14}
                    >
                      {t('workflow.shellOf', { k: point.unseen, n: size })}
                    </text>
                  )
                })}
            </g>
          ) : null}

          <g style={{ fontFamily: MONO, fontSize: 10.5, fill: 'var(--tx3)' }} textAnchor="middle">
            {centers.map((x, slot) =>
              labelled(slot, slots, labelEvery) ? (
                <text key={slot} x={x} y={CHART.base + 22}>
                  {dateShort(cycles[size + slot - 1]!.startedAt)}
                </text>
              ) : null,
            )}
          </g>
          <g style={{ fontFamily: MONO, fontSize: 10, fill: 'var(--tx3)' }} textAnchor="middle">
            {centers.map((x, slot) =>
              labelled(slot, slots, labelEvery) ? (
                <text key={slot} x={x} y={CHART.base + 38}>
                  {t('workflow.cycleNo', { n: size + slot })}
                </text>
              ) : null,
            )}
          </g>
        </svg>

        {/* Слой наведения: по колонке на слот. Линия и подсказка внутри, видит их CSS. */}
        <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}>
          {centers.map((x, slot) => {
            const n = size + slot
            const tip = cycles[n - 1]
            if (tip === undefined) return null
            const left = ((x - step / 2) / CHART.width) * 100
            const rightSide = x > CHART.width / 2
            return (
              <div
                key={n}
                data-wf-slot={n}
                tabIndex={0}
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${left}%`,
                  width: `${(step / CHART.width) * 100}%`,
                }}
              >
                <div data-wf-line style={LINE} />
                <Tip
                  tip={tip}
                  point={byN.get(n) ?? null}
                  size={size}
                  leftOfLine={rightSide}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function labelled(slot: number, slots: number, every: number): boolean {
  // Последний слот подписан всегда: по нему читается, где кончается ось.
  return slot % every === 0 || slot === slots - 1
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** Линия наведения — по центру колонки слота, от верха оси до нуля. Видимость и прозрачность — в `tokens.css`: inline-стиль сильнее любого селектора. */
const LINE: CSSProperties = {
  position: 'absolute',
  top: CHART.top,
  height: CHART.base - CHART.top,
  left: '50%',
  borderLeft: '1px solid var(--tx3)',
}

interface TipProps {
  tip: WorkflowCycleTip
  point: WorkflowReworkDot | null
  size: number
  /** Подсказка слева от линии — у правой половины оси, чтобы не вылезть за край. */
  leftOfLine: boolean
}

/** Подсказка точки № n — `cycles[n − 1]` (9.4): окно, записи исполнителя, «после него», накладные. */
function Tip({ tip, point, size, leftOfLine }: TipProps): ReactElement {
  const from = tip.n - size + 1
  const row = { display: 'flex', justifyContent: 'space-between', fontSize: 11.5 } as const
  const value = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' } as const
  return (
    <div
      data-wf-tip={tip.n}
      style={{
        position: 'absolute',
        top: 56,
        left: '50%',
        transform: leftOfLine ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
        minWidth: 212,
        maxWidth: 320,
        width: 'max-content',
        padding: '8px 12px',
        background: 'var(--s2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        boxSizing: 'border-box',
        zIndex: 1,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600 }}>
        {t('workflow.tipTitle', { n: tip.n, date: dateShort(tip.startedAt), project: tip.project })}
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 11,
          color: 'var(--tx2)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {point === null
          ? t('workflow.tipWindowNone', { from, to: tip.n })
          : t('workflow.tipWindow', {
              from,
              to: tip.n,
              value: formatPercent(point.value, 1),
              num: point.numerator,
              den: point.denominator,
            })}
      </span>
      <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
      {tip.unseen ? (
        <span data-wf-tip-unseen style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
          {t('workflow.tipUnseen')}
        </span>
      ) : (
        <div style={row}>
          <span style={{ color: 'var(--tx2)' }}>{roleName('executor')}</span>
          <span style={value}>{t('workflow.tipEdits', { count: tip.executorWrites })}</span>
        </div>
      )}
      {tip.after.length === 0 ? (
        <div style={row}>
          <span style={{ color: 'var(--tx2)' }}>{t('workflow.tipAfterNone')}</span>
          <span style={value}>0</span>
        </div>
      ) : (
        tip.after.map((item) => (
          <div key={item.role} style={row}>
            <span style={{ color: 'var(--tx2)' }}>
              {t('workflow.tipAfterRole', { role: roleName(item.role) })}
            </span>
            <span style={value}>{item.count}</span>
          </div>
        ))
      )}
      <div style={row}>
        <span style={{ color: 'var(--tx2)' }}>{t('workflow.tipOverhead')}</span>
        <span style={value}>
          {tip.overhead === null
            ? '—'
            : `${tip.overheadApproximate ? '≈' : ''}${formatMultiple(tip.overhead)}`}
        </span>
      </div>
    </div>
  )
}
