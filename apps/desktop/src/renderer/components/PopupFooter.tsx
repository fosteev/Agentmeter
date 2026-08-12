// Подвал попапа — строки 462–471 макета: слева «Сегодня», справа сумма за
// сутки, ниже «22 сессии · 8 проектов» и кнопка в большое окно.
//
// Сумма приходит готовой строкой вместе со знаком точности. Складывать четыре
// вида токенов здесь нельзя: это второй счёт того же расхода, и точность
// суммы пришлось бы выводить из четырёх чужих — в контракте для этого есть
// `DayTotals.total`.
import { t } from '../format.ts'

export interface PopupFooterProps {
  /** Готовое число за сутки, например «344,9M» или «≈344,9M». */
  total: string
  /** Готовая подпись, например «22 сессии · 8 проектов». */
  summary: string
  onOpenWindow?: (() => void) | undefined
}

export function PopupFooter({ total, summary, onOpenWindow }: PopupFooterProps) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--s1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 10,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          {t('popup.footerToday')}
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 15,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {total}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {summary}
        </span>
        <button
          type="button"
          onClick={onOpenWindow}
          style={{
            fontSize: 12,
            fontFamily: 'inherit',
            padding: '5px 10px',
            border: '1px solid var(--line)',
            borderRadius: 6,
            color: 'var(--tx)',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          {t('popup.openWindow')}
        </button>
      </div>
    </div>
  )
}
