import type { HistoryScreen, HistorySpan } from '@agentmeter/ipc'
import { HistoryBars } from './HistoryBars.tsx'
import { HistoryHeatmap } from './HistoryHeatmap.tsx'
import { HistorySide } from './HistorySide.tsx'
import { formatTokens, t } from '../format.ts'

/**
 * Вкладка «История» — разделы 8 и 8б макета (4.6).
 *
 * Считается здесь ровно одно: высота столбика против самого высокого и
 * насыщенность клетки против самой густой — длины внутри своих диаграмм
 * (правило 3.0). Числа, доли, подпись про покрытие и медиана приезжают
 * посчитанными.
 *
 * **Три пустоты не схлопываются, и это главное свойство экрана.** Час без
 * расхода — фон клетки, день с нулём — «0» с полоской в два пикселя, день без
 * данных — тире и пустая рамка. Первые два измерены, третий означает «этих
 * суток мы не видели».
 */
export interface HistoryTabProps {
  screen: HistoryScreen | null
  onSpanChange: (span: HistorySpan) => void
  onSelectDay: (at: number) => void
}

const SPANS: Array<{ span: HistorySpan; key: 'history.span7' | 'history.span30' | 'history.spanAll' }> = [
  { span: 'week', key: 'history.span7' },
  { span: 'month', key: 'history.span30' },
  { span: 'all', key: 'history.spanAll' },
]

export function HistoryTab({ screen, onSpanChange, onSelectDay }: HistoryTabProps) {
  if (screen === null || screen.emptyIndex || screen.firstDay === null) {
    return (
      <div
        data-history-empty
        style={{
          gridColumn: '1 / -1',
          padding: '22px 24px',
          color: 'var(--tx2)',
          fontSize: 12.5,
        }}
      >
        {screen?.emptyIndex === false ? t('history.emptyRange') : t('history.emptyIndex')}
      </div>
    )
  }

  return (
    <div
      data-history
      style={{
        // Обе колонки окна, а не первая: своя правая колонка у истории есть
        // (`HistorySide`, 320 точек), но живёт она **внутри** этой сетки. Без
        // захвата экран съезжает в `1fr` окна, и справа остаются пустые 300
        // точек, а хитмап с барами сжимаются вдвое.
        gridColumn: '1 / -1',
        display: 'grid',
        gridTemplateColumns: '1fr 320px',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line)' }}>
        <div
          style={{
            padding: '18px 24px 10px',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
            <span style={{ fontSize: 20, fontWeight: 600 }}>{title(screen)}</span>
            <span
              data-history-coverage
              style={{ ...mono(12), color: 'var(--tx2)' }}
            >
              {screen.coverage}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--s1)', borderRadius: 6 }}
            >
              {SPANS.map(({ span, key }) => (
                <button
                  key={span}
                  type="button"
                  data-history-span={span}
                  aria-pressed={screen.span === span}
                  onClick={() => onSpanChange(span)}
                  style={{
                    padding: '5px 11px',
                    fontSize: 11.5,
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    background: screen.span === span ? 'var(--s2)' : 'transparent',
                    color: screen.span === span ? 'var(--tx)' : 'var(--tx2)',
                  }}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span data-history-total style={{ ...mono(22), fontWeight: 600 }}>
                {screen.total.confidence === 'exact' ? '' : '≈'}
                {formatTokens(screen.total.value)}
              </span>
              <span style={{ ...mono(11), color: 'var(--tx3)' }}>{t('history.tokensWord')}</span>
            </div>
          </div>
        </div>

        <HistoryBars
          days={screen.days}
          {...(screen.selected === undefined ? {} : { selected: screen.selected.at })}
          onSelectDay={onSelectDay}
        />
        <div style={{ height: 1, background: 'var(--line)' }} />
        <HistoryHeatmap days={screen.days} />
      </div>

      <HistorySide
        {...(screen.selected === undefined ? {} : { summary: screen.selected })}
        firstDay={screen.firstDay}
        daysWithSpend={screen.daysWithSpend}
      />
    </div>
  )
}

/**
 * Заголовок периода — «3 — 9 августа».
 *
 * Собирает окно: это подстановка двух приехавших дат в постоянный шаблон, а не
 * суждение (правило 3.0). Суждение стоит рядом и приезжает готовым — это
 * `coverage`, где сказано, чем пустой столбик отличается от нулевого.
 */
function title(screen: HistoryScreen): string {
  const from = new Date(screen.from)
  const to = new Date(screen.to - 1)
  const same = from.getMonth() === to.getMonth()
  const day = (at: Date, withMonth: boolean): string =>
    at.toLocaleDateString(
      undefined,
      withMonth ? { day: 'numeric', month: 'long' } : { day: 'numeric' },
    )
  return `${day(from, !same)} — ${day(to, true)}`
}

export function mono(size: number): Record<string, string | number> {
  return {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: size,
    fontVariantNumeric: 'tabular-nums',
  }
}
