import { t } from '../format.ts'

// Шапка попапа — строки 334–345 макета: логотип-столбики, имя, справа
// «обновлено N с назад» и кнопка обновления.
//
// Столбики нарисованы кодом, а не картинкой: три полоски 3px шириной высотой
// 12/9/6, две янтарные и одна холодная — те же два цвета, что и у бейджей
// провайдеров. Иконка трея (2.7) будет строиться из этой же фигуры.
//
// «Обновлено» — не украшение. Попап живёт на push-событиях, и если поток встал,
// единственный видимый признак этого — растущее число здесь. Считается от
// `TraySnapshot.at`, а не от часов рендерера: иначе задержка доставки события
// показывается как свежесть.
//
// Кнопка рядом (7.2) — ответ на это число: она пересобирает снимок из индекса.
// В сеть отсюда никто не ходит — за лимитами по требованию ходит вторая кнопка,
// у блока лимитов (6.3, 6.4), и слить их в одну значит либо дёргать провайдера
// на каждое обновление, либо тихо не обновлять лимиты.

export interface PopupHeaderProps {
  /** Готовая подпись, например «обновлено 2 с назад». Считает не окно. */
  updated: string
  /** Пересобрать снимок. Нет обработчика — нет и кнопки: мёртвая хуже отсутствующей. */
  onRefresh?: (() => void) | undefined
  /** Пересборка идёт: значок крутится, второе нажатие не проходит. */
  busy?: boolean
}

const BARS = [
  { height: 12, color: 'var(--claude)' },
  { height: 9, color: 'var(--claude)' },
  { height: 6, color: 'var(--codex)' },
]

export function PopupHeader({ updated, onRefresh, busy = false }: PopupHeaderProps) {
  return (
    <div
      style={{
        padding: '12px 14px 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 12 }}>
          {BARS.map((bar) => (
            <div
              key={`${bar.height}-${bar.color}`}
              style={{ width: 3, height: bar.height, background: bar.color }}
            />
          ))}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Agentmeter</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx3)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {updated}
        </div>
        {onRefresh === undefined ? null : (
          <button
            type="button"
            data-popup-action="refresh"
            onClick={onRefresh}
            disabled={busy}
            aria-label={t('popup.refresh')}
            title={t('popup.refresh')}
            style={{
              width: 22,
              height: 22,
              // Ноль — сброс браузерного отступа у системной кнопки, а не число
              // из макета: в макете на этом месте нарисован `div`, у которого
              // своего отступа нет вовсе.
              padding: 0,
              border: '1px solid var(--line)',
              borderRadius: 5,
              background: 'transparent',
              color: busy ? 'var(--tx3)' : 'var(--tx2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={busy ? { animation: 'am-spin 0.9s linear infinite' } : undefined}
            >
              <path d="M10.1 7.2A4.4 4.4 0 1 1 9.9 4.3" />
              <path d="M10.6 1.6v3h-3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
