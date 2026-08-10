import type { Provider } from '@agentmeter/core'
import { formatTokens } from '../format.ts'
import { hatch } from '../paint.ts'

// Элемент развёртки. Два вида из строк 191–202 макета:
// разовый расход — сплошная заливка цветом провайдера (по умолчанию codex);
// постоянный — штриховка warn плюс пунктирная рамка, число в tx2. Это та же
// ось «точно/оценка», что в LimitBar: сплошное = измерено, штрих = оценочно
// или регулярно платится. Процент считает компонент от max — в 4.2 он
// считается по aggregates из packages/core/src/query/types.ts.

export interface BreakdownRowProps {
  label: string
  tokens: number
  max: number
  persistent: boolean
  accent?: Provider
  variant?: 'breakdown' | 'task'
  calls?: number
  confidence?: 'exact' | 'estimate' | 'reconstructed'
  caveat?: string
  note?: string
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

export function BreakdownRow({
  label,
  tokens,
  max,
  persistent,
  accent = 'codex',
  variant = 'breakdown',
  calls,
  confidence = 'exact',
  caveat,
  note,
}: BreakdownRowProps) {
  const pct = max > 0 ? Math.min(100, (tokens / max) * 100) : 0
  const task = variant === 'task'
  const approximate = confidence !== 'exact'
  const barColor = note === undefined ? ACCENT[accent] : 'var(--alarm)'
  const title = [note, approximate ? caveat : undefined].filter(Boolean).join('\n') || undefined

  return (
    <div
      data-breakdown-row={label}
      title={title}
      style={{
        display: 'grid',
        gridTemplateColumns: task ? '104px 1fr 56px' : '96px 1fr 64px',
        gap: 10,
        alignItems: 'center',
      }}
    >
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: task ? 11.5 : 12 }}>
        {label}
        {task && calls !== undefined ? <span style={{ color: 'var(--tx3)' }}> {calls}</span> : null}
      </span>
      <div
        style={{
          height: task ? 9 : 10,
          borderRadius: 2,
          background: 'var(--s2)',
          overflow: 'hidden',
          border: persistent
            ? `1px dashed color-mix(in oklch, var(--warn) 50%, transparent)`
            : undefined,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: persistent
              ? hatch('var(--warn)')
              : approximate
                ? hatch(barColor)
                : barColor,
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          textAlign: 'right',
          color: note !== undefined ? 'var(--alarm)' : persistent ? 'var(--tx2)' : 'var(--tx)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {approximate ? '≈' : ''}
        {formatTokens(tokens)}
      </span>
    </div>
  )
}
