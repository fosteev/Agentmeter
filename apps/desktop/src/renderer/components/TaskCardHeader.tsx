import type { Provider } from '@agentmeter/core'
import type { TaskCard as TaskCardData } from '@agentmeter/ipc'
import { clock, formatTokens, t } from '../format.ts'
import { span } from '../time.ts'

const PROVIDER: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export function TaskCardHeader({ card }: { card: TaskCardData }) {
  const { task } = card
  const approximate = task.tokens.confidence !== 'exact'
  const provider = `var(--${task.provider})`
  const providerModel = [PROVIDER[task.provider], task.model].filter(Boolean).join(' · ')
  const projectBranch = [task.project, task.branch].filter(Boolean).join(' · ')

  return (
    <div
      data-task-card-header=""
      style={{
        padding: '18px 22px',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: task.title === null ? 'var(--tx3)' : undefined,
          }}
        >
          {task.title ?? t('card.untitled')}
        </div>
        <div
          data-task-card-meta=""
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11.5,
            color: 'var(--tx2)',
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span style={{ color: provider }}>{providerModel}</span>
          <span>{projectBranch}</span>
          <span>
            {clock(task.startedAt)} → {clock(task.endedAt)}
          </span>
          <span>{span(task.endedAt - task.startedAt)}</span>
          <span>{t('today.requests', { count: task.requests })}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span
          title={approximate ? task.tokens.caveat : undefined}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 24,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {approximate ? '≈' : ''}
          {formatTokens(task.tokens.value)}
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx3)',
            whiteSpace: 'nowrap',
          }}
        >
          {t('card.dayShare', { percent: Math.round(card.dayShare * 100) })}
        </span>
      </div>
    </div>
  )
}
