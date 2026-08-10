// Шапка попапа — строки 334–340 макета: логотип-столбики, имя, справа
// «обновлено N с назад».
//
// Столбики нарисованы кодом, а не картинкой: три полоски 3px шириной высотой
// 12/9/6, две янтарные и одна холодная — те же два цвета, что и у бейджей
// провайдеров. Иконка трея (2.7) будет строиться из этой же фигуры.
//
// «Обновлено» — не украшение. Попап живёт на push-событиях, и если поток встал,
// единственный видимый признак этого — растущее число здесь. Считается от
// `TraySnapshot.at`, а не от часов рендерера: иначе задержка доставки события
// показывается как свежесть.

export interface PopupHeaderProps {
  /** Готовая подпись, например «обновлено 2 с назад». Считает не окно. */
  updated: string
}

const BARS = [
  { height: 12, color: 'var(--claude)' },
  { height: 9, color: 'var(--claude)' },
  { height: 6, color: 'var(--codex)' },
]

export function PopupHeader({ updated }: PopupHeaderProps) {
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
    </div>
  )
}
