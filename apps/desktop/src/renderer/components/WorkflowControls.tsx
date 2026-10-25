import type { ReactNode } from 'react'
import type {
  WorkflowControl,
  WorkflowDelta,
  WorkflowDot,
  WorkflowVerdictKey,
  WorkflowVerdictsControl,
  WorkflowWindowValue,
} from '@agentmeter/ipc'
import { formatMultiple, formatPercent, formatSigned, t } from '../format.ts'
import { MONO, verdictName } from '../workflow.ts'

/**
 * Три контрольных показателя — строки 2693–2751 макета (раздел 13, 9.5).
 *
 * Стоят рядом с главным числом, чтобы доля переделки не падала за чужой счёт:
 * дороже приёмка (накладные), больше ошибок, мягче вердикты. Цели у них нет, и
 * дельта всегда нейтральная — экран не говорит «плохо».
 *
 * Ничего здесь не считается: значение, окно «до него» и дельта приехали
 * посчитанными. Окну остаётся перевести точки в координаты своей линии.
 */

export interface WorkflowControlsProps {
  overhead: WorkflowControl
  errors: WorkflowControl
  verdicts: WorkflowVerdictsControl
}

export function WorkflowControls({ overhead, errors, verdicts }: WorkflowControlsProps) {
  return (
    <div
      data-workflow-controls
      style={{
        padding: '20px 32px',
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 20,
        borderBottom: '1px solid var(--line)',
      }}
    >
      <OverheadCard control={overhead} />
      <ErrorsCard control={errors} />
      <VerdictsCard control={verdicts} />
    </div>
  )
}

const caps = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--tx3)',
} as const

const note = { fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 } as const

function Card({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <div
      data-workflow-control={name}
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <span style={caps}>{title}</span>
      {children}
    </div>
  )
}

/** Число слева, дельта справа: «×0.45» и «≈−6.63 · до него ≈×7.09». */
function Headline({ value, side }: { value: string; side: string | null }) {
  return (
    <div
      style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}
    >
      <span
        data-workflow-value
        style={{
          fontFamily: MONO,
          fontSize: 20,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      {side === null ? null : (
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: 'var(--tx2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {side}
        </span>
      )}
    </div>
  )
}

const approx = (flag: boolean): string => (flag ? '≈' : '')

/** «+1.6 п.п. · до него 0.0%» — дельта в п.п. и окно, с которым сравнивали. */
function percentSide(
  delta: WorkflowDelta | null,
  prev: WorkflowWindowValue | null,
  latest: WorkflowWindowValue | null,
): string | null {
  if (latest === null) return null
  if (delta === null || prev === null) return t('workflow.deltaNone')
  const move = t('workflow.deltaPoints', { value: formatSigned(delta.value, 1) })
  return `${approx(delta.approximate)}${move} · ${t('workflow.beforeValue', {
    value: formatPercent(prev.value, 1),
  })}`
}

// ─── накладные ────────────────────────────────────────────────────────────────

function OverheadCard({ control }: { control: WorkflowControl }) {
  const { latest, prev, delta } = control
  const side =
    latest === null
      ? null
      : delta === null || prev === null
        ? t('workflow.deltaNone')
        : `${approx(delta.approximate)}${formatSigned(delta.value, 2)} · ${t('workflow.beforeValue', {
            value: `${approx(prev.approximate)}${formatMultiple(prev.value)}`,
          })}`
  const points = control.points
  return (
    <Card name="overhead" title={t('workflow.overheadTitle')}>
      <Headline
        value={
          latest === null ? '—' : `${approx(latest.approximate)}${formatMultiple(latest.value)}`
        }
        side={side}
      />
      <Spark points={points} scale={Math.max(...points.map((point) => point.value), 0)} />
      <Axis points={points} />
      <span style={note}>
        {latest === null ? t('workflow.controlEmpty') : t('workflow.overheadNote')}
      </span>
    </Card>
  )
}

// ─── ошибки ───────────────────────────────────────────────────────────────────

function ErrorsCard({ control }: { control: WorkflowControl }) {
  const { latest, prev, delta, points } = control
  const back = points.length < 2 ? 0 : points[points.length - 1]!.n - points[0]!.n
  return (
    <Card name="errors" title={t('workflow.errorsTitle')}>
      <Headline
        value={latest === null ? '—' : formatPercent(latest.value, 1)}
        side={percentSide(delta, prev, latest)}
      />
      <Spark points={points} scale={Math.max(...points.map((point) => point.value), 0)} />
      <div style={axisRow}>
        <span>{back === 0 ? '' : t('workflow.windowsBack', { count: back })}</span>
        <span>{t('workflow.now')}</span>
      </div>
      <span style={note}>
        {latest === null
          ? t('workflow.controlEmpty')
          : t('workflow.errorsNote', {
              count: control.size,
              num: latest.numerator,
              den: latest.denominator,
            })}
      </span>
    </Card>
  )
}

// ─── вердикты ─────────────────────────────────────────────────────────────────

/**
 * Три ступени светлоты `--tx` и контур у «вердикта нет» (9.4): цвета оценки у
 * вердиктов нет, как нет её и у остального экрана. Ступени 78 и 52 — из макета;
 * третья (30) мягче второй, потому что «не принято» в макете нулевое и своей
 * полосы там нет.
 */
const TINTS: Record<Exclude<WorkflowVerdictKey, 'none'>, number> = {
  accepted: 78,
  notes: 52,
  rejected: 30,
}
const VERDICT_ORDER: readonly WorkflowVerdictKey[] = ['accepted', 'notes', 'rejected', 'none']

function VerdictsCard({ control }: { control: WorkflowVerdictsControl }) {
  const { latest, prev, delta, points, counts } = control
  const total = counts === null ? 0 : VERDICT_ORDER.reduce((sum, key) => sum + counts[key], 0)
  return (
    <Card name="verdicts" title={t('workflow.verdictsTitle')}>
      <Headline
        value={latest === null ? '—' : formatPercent(latest.value, 1)}
        side={percentSide(delta, prev, latest)}
      />
      {/* Доля вердиктов — от нуля до единицы, и линия рисуется на этой шкале: «87.5%»
          у самого верха, а не растянутые под наибольшую из точек. */}
      <Spark points={points} scale={1} />
      {counts === null || total === 0 ? null : (
        <>
          <div
            data-workflow-verdict-strip
            style={{
              display: 'flex',
              gap: 1,
              height: 8,
              borderRadius: 2,
              overflow: 'hidden',
              background: 'var(--s2)',
            }}
          >
            {VERDICT_ORDER.filter((key) => counts[key] > 0).map((key) => (
              <div
                key={key}
                data-workflow-verdict={key}
                style={{
                  width: `${(counts[key] / total) * 100}%`,
                  ...(key === 'none'
                    ? { boxShadow: 'inset 0 0 0 1px var(--tx3)' }
                    : {
                        background: `color-mix(in oklch, var(--tx) ${TINTS[key]}%, transparent)`,
                      }),
                }}
              />
            ))}
          </div>
          <span
            data-workflow-verdict-counts
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              color: 'var(--tx3)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {VERDICT_ORDER.map((key) => `${verdictName(key)} ${counts[key]}`).join(' · ')}
          </span>
        </>
      )}
      <span style={note}>
        {latest === null
          ? t('workflow.controlEmpty')
          : t('workflow.verdictsNote', { count: latest.denominator })}
      </span>
    </Card>
  )
}

// ─── линия ────────────────────────────────────────────────────────────────────

const SPARK = { width: 318, left: 4, right: 314, base: 44, height: 36 } as const

export interface SparkSpot {
  n: number
  x: number
  y: number
  approximate: boolean
}

/**
 * Точки ряда → координаты линии 318 × 48. X — по номеру окна, не по порядку:
 * пропущенное окно (знаменатель нулевой) оставляет пустое место, а не сдвигает
 * соседей. Y — доля наибольшей точки (или заданной шкалы); при нулевой шкале всё
 * лежит на оси.
 */
export function sparkSpots(points: readonly WorkflowDot[], scale: number): SparkSpot[] {
  if (points.length === 0) return []
  const first = points[0]!.n
  const last = points[points.length - 1]!.n
  return points.map((point) => ({
    n: point.n,
    approximate: point.approximate,
    x:
      last === first
        ? SPARK.right
        : SPARK.left + ((SPARK.right - SPARK.left) * (point.n - first)) / (last - first),
    y: scale <= 0 ? SPARK.base : SPARK.base - (point.value / scale) * SPARK.height,
  }))
}

function Spark({ points, scale }: { points: readonly WorkflowDot[]; scale: number }) {
  const spots = sparkSpots(points, scale)
  const last = spots.length - 1
  return (
    <svg
      data-workflow-spark
      width="100%"
      height="48"
      viewBox={`0 0 ${SPARK.width} 48`}
      preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <line
        x1={0}
        y1={SPARK.base}
        x2={SPARK.width}
        y2={SPARK.base}
        style={{ stroke: 'var(--line)', strokeWidth: 1 }}
      />
      {/* Отрезок между соседними номерами; пунктир — если хоть один конец оценочный. */}
      {spots.slice(1).map((spot, index) => {
        const from = spots[index]!
        if (spot.n !== from.n + 1) return null
        return (
          <line
            key={spot.n}
            x1={round(from.x)}
            y1={round(from.y)}
            x2={round(spot.x)}
            y2={round(spot.y)}
            style={{
              stroke: 'var(--tx2)',
              strokeWidth: 1.5,
              ...(from.approximate || spot.approximate ? { strokeDasharray: '3 3' } : {}),
            }}
          />
        )
      })}
      {spots.map((spot, index) =>
        index === last ? (
          <circle
            key={spot.n}
            cx={round(spot.x)}
            cy={round(spot.y)}
            r={3}
            style={{ fill: 'var(--tx)' }}
          />
        ) : (
          <circle
            key={spot.n}
            data-workflow-hollow={spot.approximate ? '' : undefined}
            cx={round(spot.x)}
            cy={round(spot.y)}
            r={2.5}
            style={
              spot.approximate
                ? { fill: 'var(--s1)', stroke: 'var(--tx2)', strokeWidth: 1.2 }
                : { fill: 'var(--tx2)' }
            }
          />
        ),
      )}
    </svg>
  )
}

const axisRow = {
  display: 'flex',
  justifyContent: 'space-between',
  fontFamily: MONO,
  fontSize: 10,
  color: 'var(--tx3)',
  fontVariantNumeric: 'tabular-nums',
} as const

function Axis({ points }: { points: readonly WorkflowDot[] }) {
  if (points.length === 0) return null
  return (
    <div style={axisRow}>
      <span>{t('workflow.cycleNo', { n: points[0]!.n })}</span>
      <span>{t('workflow.cycleNo', { n: points[points.length - 1]!.n })}</span>
    </div>
  )
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
