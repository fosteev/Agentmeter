import type { Provider } from '@agentmeter/core'
import { LimitBar } from './LimitBar.tsx'
import { ProviderBadge } from './ProviderBadge.tsx'

// Блок лимита в попапе — строки 413–420 макета: шапка с бейджем, именем окна и
// процентом, под ней полоса, под ней тихая подпись про сброс.
//
// Здесь живёт единственное место продукта, где «не знаем» обязано выглядеть не
// как ноль. У Claude до калибровки веса `cache_read` (этап 1.9) процента нет
// вовсе, и полоса рисуется пустой, процент — прочерком, а причина уходит в
// подпись вместо времени сброса. Ноль на этом месте означал бы «ничего не
// израсходовано», то есть ровно ту ложь, ради борьбы с которой затевался
// измерительный продукт.
//
// Цвет процента взят из макета и следует уровню, а не точности: 5% нейтральны
// (строка 416), ≈68% янтарны (425), ≈31% уходят в tx2 (434). То есть оценка
// приглушает число только там, где тревожить не о чем.

export interface PopupLimitProps {
  provider: Provider
  /** Имя окна: «недельное окно», «5-часовое окно». */
  title: string
  percent: number | null
  /** Оценка: знак «≈» у числа и штриховка в полосе. */
  approximate: boolean
  /**
   * Нижняя строка: «сброс через 6 д 4 ч», а при неизвестном проценте — причина,
   * по которой его нет. Готовый текст, окно ничего не считает.
   */
  caption: string
}

function percentColor(percent: number | null, approximate: boolean): string | undefined {
  if (percent === null) return 'var(--tx3)'
  if (percent > 85) return 'var(--alarm)'
  if (percent >= 60) return 'var(--warn)'
  return approximate ? 'var(--tx2)' : undefined
}

export function PopupLimit({ provider, title, percent, approximate, caption }: PopupLimitProps) {
  const known = percent !== null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12 }}>
          <ProviderBadge provider={provider} marginRight={6} />
          {title}
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            color: percentColor(percent, approximate),
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {known ? `${approximate ? '≈' : ''}${Math.round(percent)}%` : '—'}
        </span>
      </div>
      <LimitBar percent={percent} approximate={approximate} size="popup" label={false} />
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          color: 'var(--tx3)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {caption}
      </div>
    </div>
  )
}
