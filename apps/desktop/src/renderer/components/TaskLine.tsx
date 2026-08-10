import type { Provider } from '@agentmeter/core'
import type { TaskRow } from '@agentmeter/ipc'
import { clock, formatTokens, t } from '../format.ts'
import { hatch } from '../paint.ts'
import { span } from '../time.ts'

export interface TaskLineProps {
  task: TaskRow
  maxTokens: number
}

const PROVIDER: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

function estimated(task: TaskRow): boolean {
  return task.tokens.confidence !== 'exact'
}

export function TaskLine({ task, maxTokens }: TaskLineProps) {
  const approximate = estimated(task)
  const width = maxTokens === 0 ? 0 : (task.tokens.value / maxTokens) * 100
  const details = [task.model, span(task.endedAt - task.startedAt), PROVIDER[task.provider]].filter(
    (part): part is string => part !== undefined,
  )

  return (
    <div
      data-task-id={task.sessionId}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 118px 84px 96px 92px',
        gap: 14,
        alignItems: 'center',
        padding: '9px 12px',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        {task.title === null ? (
          <>
            <span
              style={{
                fontSize: 13.5,
                color: 'var(--tx3)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 14, height: 1, background: 'var(--tx3)', flex: 'none' }}
              />
              {t('card.untitled')}
            </span>
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10.5,
                color: 'var(--tx3)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                opacity: 0.8,
              }}
            >
              {t('today.firstPrompt', { prompt: task.firstPrompt ?? '' })}
            </span>
          </>
        ) : (
          <>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {task.title}
            </span>
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10.5,
                color: 'var(--tx3)',
                whiteSpace: 'nowrap',
              }}
            >
              {details.join(' · ')}
            </span>
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12,
            color: 'var(--tx2)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {task.project}
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 10.5,
            color: 'var(--tx3)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {task.branch ?? ''}
        </span>
      </div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          color: 'var(--tx2)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {clock(task.startedAt)}
      </div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          color: 'var(--tx2)',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {task.requests}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span
          title={task.tokens.caveat}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 13,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {approximate ? '≈' : ''}
          {formatTokens(task.tokens.value)}
        </span>
        <div
          style={{
            width: 76,
            height: 3,
            borderRadius: 2,
            background: 'var(--s2)',
            overflow: 'hidden',
          }}
        >
          <div
            data-token-fill={task.sessionId}
            style={{
              width: `${width}%`,
              height: '100%',
              background: approximate
                ? hatch(`var(--${task.provider})`)
                : `var(--${task.provider})`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
