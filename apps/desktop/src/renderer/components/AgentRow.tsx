import type { Provider } from '@agentmeter/core'
import { formatTokens } from '../format.ts'

// Строка агента. Состояния из строк 145–171 макета:
// думает (пульс ок-точкой) · ждёт (контур warn) · завершён (гашение opacity .55,
// акцент tx3). Два сквозных различия заданы цветом акцента: Claude — янтарный,
// Codex — холодный. Подписей-дисклеймеров нет: точность видна по штриховке
// в LimitBar/BreakdownRow, здесь её нет.

export type AgentStatus = 'thinking' | 'waiting' | 'done'

export interface AgentRowProps {
  provider: Provider
  project: string
  status: AgentStatus
  tokens: number
  /** Только для status='done': «2 мин назад». */
  endedAgo?: string
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

const LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export function AgentRow({ provider, project, status, tokens, endedAgo }: AgentRowProps) {
  const done = status === 'done'
  const accent = done ? 'var(--tx3)' : ACCENT[provider]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '3px 1fr',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 'var(--r-inner)',
        background: done ? 'transparent' : 'var(--s2)',
        opacity: done ? 0.55 : 1,
      }}
    >
      <div style={{ background: accent, borderRadius: 2 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontSize: 13 }}>
          {LABEL[provider]} · <span style={{ color: 'var(--tx2)' }}>{project}</span>
        </div>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {done ? (
            <span>
              {endedAgo ? `завершился ${endedAgo}` : 'завершился'} · {formatTokens(tokens)}
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Dot status={status} />
              {status === 'thinking' ? 'думает' : 'ждёт ответа'} · {formatTokens(tokens)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function Dot({ status }: { status: AgentStatus }) {
  if (status === 'thinking') {
    return (
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'var(--ok)',
          animation: 'am-pulse 1.6s ease-in-out infinite',
        }}
      />
    )
  }
  return (
    <span
      style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        border: '1px solid var(--warn)',
        boxSizing: 'border-box',
      }}
    />
  )
}
