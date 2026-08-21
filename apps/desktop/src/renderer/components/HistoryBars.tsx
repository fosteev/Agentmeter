import { useEffect, useRef } from 'react'
import type { HistoryDay } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { mono } from './HistoryTab.tsx'

/**
 * Столбики недели — строки 1344–1379 макета (4.6).
 *
 * Высота столбика — единственное, что здесь считается: доля от самого высокого
 * дня периода. Второго потребителя у неё нет, текстом её не видно (правило 3.0).
 *
 * **Три вида дня рисуются тремя разными способами, и это не украшение.**
 * `tokens === null` — данных за сутки нет: тире и пустая рамка. `tokens === 0`
 * — измеренный ноль: «0» и полоска в два пикселя, потому что «работы не было»
 * это факт, и показывать его отсутствием значило бы стереть измерение.
 *
 * **Столбик не сжимается ниже своей подписи, а ряд едет вбок.** В макете
 * нарисована неделя, и семь долей `1fr` там шире любого числа над ними. На
 * тридцати днях та же доля — 23 точки при `≈296.7M` в 46, то есть числа
 * налезают друг на друга, а на «всё» (191 сутки роллаутов Codex на живой
 * машине) от столбика остаётся четверть точки. Поэтому у колонки есть
 * измеренный минимум, а ряд шире окна прокручивается.
 */
export interface HistoryBarsProps {
  days: HistoryDay[]
  selected?: number
  onSelectDay: (at: number) => void
}

const HEIGHT = 130
/**
 * Ширина колонки, ниже которой ряд перестаёт помещаться в себя.
 *
 * Самое длинное число над столбиком — `≈296.7M`: семь знаков моноширинного
 * кегля 11, то есть 46 точек. Плюс зазор — 52. Считать её по самому длинному
 * числу периода нельзя: колонки разъезжались бы от того, что вчера был
 * миллиард, а сегодня тысяча.
 */
const COLUMN = 52
const GAP = 4
/** Поля ряда — те же 24 точки макета, но их надо знать числом для ширины. */
const SIDES = 48

export function HistoryBars({ days, selected, onSelectDay }: HistoryBarsProps) {
  const tallest = Math.max(0, ...days.map((day) => day.tokens?.value ?? 0))
  const wide = days.length * COLUMN + Math.max(0, days.length - 1) * GAP + SIDES
  const scroller = useRef<HTMLDivElement>(null)
  const first = days[0]?.at ?? 0

  /**
   * Прокрутка открывается на выбранном дне, а не на начале периода.
   *
   * Без этого «30 дней» открываются на месячной давности, а «всё» — на первом
   * логе, который у Codex старше полугода: человек видит край истории и пустые
   * столбики до первого лога Claude, а сегодняшний день — за правым краем.
   * Позиция прокрутки живёт только в DOM, посчитать её в main нечем, поэтому
   * это единственный эффект среди компонентов окна. `nearest` выбран, чтобы
   * клик по видимому столбику ряд не дёргал.
   */
  useEffect(() => {
    const box = scroller.current
    if (box === null || box.scrollWidth <= box.clientWidth) return
    const bar =
      selected === undefined
        ? null
        : box.querySelector<HTMLElement>(`[data-history-day="${selected}"]`)
    if (bar === null) box.scrollLeft = box.scrollWidth
    else bar.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [first, days.length, selected])

  return (
    <div ref={scroller} data-history-bars style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div
        style={{
          // `width` даёт ширину окна, `minWidth` — ширину ряда, и берётся
          // большее из двух: на неделе колонки тянутся как в макете, на месяце
          // ряд перестаёт сжиматься и уезжает под прокрутку.
          width: '100%',
          minWidth: wide,
          boxSizing: 'border-box',
          padding: '6px 24px 16px',
          display: 'flex',
          gap: GAP,
          alignItems: 'flex-end',
        }}
      >
        {days.map((day) => {
          const chosen = day.at === selected
          return (
            <button
              key={day.at}
              type="button"
              data-history-day={day.at}
              data-history-day-state={day.tokens === null ? 'absent' : day.tokens.value === 0 ? 'zero' : 'spend'}
              aria-pressed={chosen}
              // Знак `≈` над столбиком объясняется здесь же: у оценки бывает две
              // причины (восстановленные запросы и удалённый лог), и молчаливый
              // знак читается как «мы округлили».
              title={day.tokens?.caveat}
              onClick={() => onSelectDay(day.at)}
              style={{
                flex: 1,
                minWidth: COLUMN,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 6,
                background: chosen ? 'var(--s1)' : 'transparent',
              }}
            >
              <span
                style={{
                  ...mono(11),
                  fontWeight: chosen ? 600 : 400,
                  color: day.tokens === null || day.tokens.value === 0 ? 'var(--tx3)' : chosen ? 'var(--tx)' : 'var(--tx2)',
                }}
              >
                {day.tokens === null
                  ? t('history.noData')
                  : day.tokens.value === 0
                    ? t('history.zero')
                    : `${day.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(day.tokens.value)}`}
              </span>
              <Column day={day} tallest={tallest} />
              <span
                style={{ ...mono(10.5), color: chosen ? 'var(--tx)' : 'var(--tx3)' }}
              >
                {label(day.at)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Column({ day, tallest }: { day: HistoryDay; tallest: number }) {
  if (day.tokens === null) {
    return (
      <div
        style={{
          width: '100%',
          maxWidth: 44,
          height: HEIGHT,
          borderRadius: 3,
          boxShadow: 'inset 0 0 0 1px var(--line)',
        }}
      />
    )
  }
  const box = {
    width: '100%',
    maxWidth: 44,
    height: HEIGHT,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'flex-end',
  }
  if (day.tokens.value === 0) {
    return (
      <div style={box}>
        <div style={{ height: 2, background: 'var(--tx3)', borderRadius: 1 }} />
      </div>
    )
  }
  // Полоска не тоньше двух пикселей: день на 12.9M против дня на 344.9M даёт
  // высоту в полпикселя, и округление вниз стёрло бы столбик совсем — то есть
  // нарисовало бы «работы не было» там, где её было на тринадцать миллионов.
  const height = Math.max(2, Math.round((day.tokens.value / Math.max(1, tallest)) * HEIGHT))
  return (
    <div style={box}>
      <div
        style={{
          height,
          borderRadius: 3,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {day.byProvider.map((slice) => (
          <div
            key={slice.provider}
            data-history-slice={slice.provider}
            style={{ flex: slice.tokens, background: `var(--${slice.provider})` }}
          />
        ))}
      </div>
    </div>
  )
}

/** «Пн 3» — подстановка приехавшей метки в постоянный формат. */
function label(at: number): string {
  const date = new Date(at)
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' })
  return `${weekday[0]?.toUpperCase() ?? ''}${weekday.slice(1, 2)} ${date.getDate()}`
}
