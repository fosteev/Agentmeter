import type { Provider } from '@agentmeter/core'
import { formatTokens } from '../format.ts'

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
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

const HATCH = `repeating-linear-gradient(115deg, var(--warn) 0 3px, color-mix(in oklch, var(--warn) 30%, transparent) 3px 7px)`

export function BreakdownRow({
  label,
  tokens,
  max,
  persistent,
  accent = 'codex',
}: BreakdownRowProps) {
  const pct = max > 0 ? Math.min(100, (tokens / max) * 100) : 0

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '96px 1fr 64px',
        gap: 10,
        alignItems: 'center',
      }}
    >
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{label}</span>
      <div
        style={{
          height: 10,
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
            background: persistent ? HATCH : ACCENT[accent],
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          textAlign: 'right',
          color: persistent ? 'var(--tx2)' : 'var(--tx)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatTokens(tokens)}
      </span>
    </div>
  )
}
