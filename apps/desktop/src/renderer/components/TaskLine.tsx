import type { ReactNode } from 'react'
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

/**
 * Ветка с выделенным ключом тикета (3.7).
 *
 * Показывается **вся** ветка, а не один ключ: `GARM-664.zigbee` и
 * `GARM-664.ui` — разная работа по одному тикету, и подмена имени ключом
 * сделала бы две строки неразличимыми. Ключ при этом виден: он ярче остатка.
 *
 * Место ключа ищется в строке, а не выводится заново: правило извлечения —
 * измерение, и живёт оно в ядре (`query/ticket.ts`). Вторая регулярка здесь
 * означала бы две модели одного и того же.
 */
function branchParts(task: TaskRow): ReactNode {
  const branch = task.branch ?? ''
  const at = task.ticket === undefined ? -1 : branch.indexOf(task.ticket)
  if (at === -1) return branch
  return (
    <>
      {branch.slice(0, at)}
      <span data-ticket={task.ticket} style={{ color: 'var(--tx2)' }}>
        {task.ticket}
      </span>
      {branch.slice(at + task.ticket!.length)}
    </>
  )
}

export function TaskLine({ task, maxTokens }: TaskLineProps) {
  const approximate = estimated(task)
  const width = maxTokens === 0 ? 0 : (task.tokens.value / maxTokens) * 100
  // Подпись собирается здесь, а не в main: это подстановка уже приехавшего
  // числа в постоянный шаблон, суждения за ней нет (правило 3.0). Число детей
  // берётся из самого списка — второй счётчик рядом разошёлся бы с ним молча.
  const subagents = task.children?.length ?? 0
  const details = [
    task.model,
    span(task.endedAt - task.startedAt),
    PROVIDER[task.provider],
    subagents === 0 ? undefined : t('today.subagents', { count: subagents }),
  ].filter((part): part is string => part !== undefined)

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
                // Подпись выросла на «3 сабагента» и в узкой колонке налезала
                // бы на соседнюю: обрезается так же, как название над ней.
                overflow: 'hidden',
                textOverflow: 'ellipsis',
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
          {branchParts(task)}
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
