import type { HistoryDay } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { mono } from './HistoryTab.tsx'

/**
 * Хитмап «день × час» — строки 1344–1395 макета (4.6).
 *
 * Цвет клетки приезжает готовым: у клетки он один, а провайдеров в часу бывает
 * два, и «чей это час» — суждение (правило 3.0). Насыщенность считается здесь:
 * это длина внутри своей диаграммы, второго потребителя у неё нет.
 *
 * **Час без расхода — фон, а не прозрачная клетка нулевой густоты.** Иначе он
 * оказался бы неотличим от часа с расходом, округлённым до нуля, — а это
 * первый из трёх видов пустоты на экране.
 */
export interface HistoryHeatmapProps {
  days: HistoryDay[]
}

/** Ниже этой густоты клетка не опускается: иначе расход выглядит его отсутствием. */
const FAINTEST = 0.22

export function HistoryHeatmap({ days }: HistoryHeatmapProps) {
  const densest = Math.max(0, ...days.flatMap((day) => day.hours.map((hour) => hour.tokens)))

  return (
    <div
      data-history-heatmap
      style={{
        flex: 1,
        padding: '16px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span
          style={{
            ...mono(10),
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          {t('history.heatmap')}
        </span>
        <span style={{ ...mono(11), color: 'var(--tx2)' }}>{t('history.heatmapHint')}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minHeight: 0 }}>
        {days.map((day) => (
          <div
            key={day.at}
            data-history-row={day.at}
            style={{ flex: 1, display: 'grid', gridTemplateColumns: '44px 1fr', gap: 10, alignItems: 'stretch' }}
          >
            <span style={{ ...mono(10.5), color: 'var(--tx3)' }}>{label(day.at)}</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2, height: '100%' }}>
              {cells(day).map((hour) => (
                <div
                  key={hour.hour}
                  data-history-cell={hour.provider ?? 'none'}
                  style={{
                    height: '100%',
                    minHeight: 24,
                    borderRadius: 2,
                    ...(hour.tokens === 0 || hour.provider === null
                      ? { background: 'var(--s1)' }
                      : {
                          background: `var(--${hour.provider})`,
                          opacity: Math.max(FAINTEST, hour.tokens / Math.max(1, densest)),
                        }),
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Двадцать четыре клетки всегда.
 *
 * У суток без данных `hours` пуст, и строка всё равно рисуется полной: ряд из
 * четырёх клеток вместо двадцати четырёх сломал бы сетку, а вместе с ней и
 * сравнение по вертикали, ради которого хитмап и нужен.
 */
function cells(day: HistoryDay): HistoryDay['hours'] {
  if (day.hours.length === 24) return day.hours
  return Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, provider: null }))
}

function label(at: number): string {
  const date = new Date(at)
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' })
  return `${weekday[0]?.toUpperCase() ?? ''}${weekday.slice(1, 2)} ${date.getDate()}`
}
