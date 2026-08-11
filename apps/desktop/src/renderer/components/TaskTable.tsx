import { useState } from 'react'
import type {
  FoldedTail as FoldedTailData,
  LiveAgent,
  TaskCard as TaskCardData,
  TaskRow,
} from '@agentmeter/ipc'
import { t } from '../format.ts'
import { FoldedTail } from './FoldedTail.tsx'
import { TaskCard } from './TaskCard.tsx'
import { TaskLine } from './TaskLine.tsx'

/**
 * Живые агенты по идентификатору сессии (6.1).
 *
 * Соединение живого снимка с лентой — поиск по ключу, а не счёт: в строке
 * появляются числа, посчитанные main, и ни одного, выведенного здесь. Именно
 * поэтому оно делается в окне, а не в отчёте: снимок приезжает раз в секунду,
 * а лента — по запросу, и вшитое в неё состояние агента застыло бы до
 * следующего.
 */
export type LiveAgents = ReadonlyMap<string, LiveAgent>

export interface TaskTableProps {
  tasks: TaskRow[]
  folded: FoldedTailData | null
  taskCard?: TaskCardData | null
  live?: LiveAgents
  onToggle?: (sessionId: string) => void
}

export function toggleTask(
  current: string | null,
  sessionId: string,
  onToggle: (sessionId: string) => void,
): string | null {
  if (current === sessionId) return null
  onToggle(sessionId)
  return sessionId
}

export function TaskRows({
  tasks,
  maxTokens,
  expandedSessionId,
  taskCard,
  live,
  onToggle,
}: {
  tasks: TaskRow[]
  maxTokens: number
  expandedSessionId: string | null
  taskCard: TaskCardData | null
  live?: LiveAgents
  onToggle: (sessionId: string) => void
}) {
  return tasks.map((task) => (
    <div key={task.sessionId} data-task-entry={task.sessionId}>
      <div
        data-task-trigger={task.sessionId}
        role="button"
        tabIndex={0}
        aria-expanded={expandedSessionId === task.sessionId}
        onClick={() => onToggle(task.sessionId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onToggle(task.sessionId)
        }}
      >
        <TaskLine task={task} maxTokens={maxTokens} live={live?.get(task.sessionId)} />
      </div>
      {expandedSessionId === task.sessionId && taskCard?.task.sessionId === task.sessionId ? (
        /*
          Карточка приезжает из IPC уже после нажатия, поэтому без раскрытия
          она просто возникает под строкой и сдвигает список — глазу негде
          связать нажатую строку с появившимся блоком. Анимация живёт на
          обёртке (`am-reveal`, tokens.css): высота карточки заранее не
          известна, а 0fr → 1fr её знать и не требует.
        */
        <div
          data-task-card-reveal={task.sessionId}
          style={{ display: 'grid', gridTemplateRows: '1fr', animation: 'am-reveal 180ms ease-out' }}
        >
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
            <TaskCard card={taskCard} live={live?.get(task.sessionId)} />
          </div>
        </div>
      ) : null}
    </div>
  ))
}

export function TaskTable({
  tasks,
  folded,
  taskCard = null,
  live,
  onToggle = () => undefined,
}: TaskTableProps) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const visible = folded === null ? tasks : tasks.slice(0, folded.from)
  const maxTokens = Math.max(0, ...tasks.map((task) => task.tokens.value))

  const handleToggle = (sessionId: string): void => {
    setExpandedSessionId((current) => toggleTask(current, sessionId, onToggle))
  }

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 118px 84px 96px 92px',
          gap: 14,
          padding: '8px 24px',
          borderTop: '1px solid var(--line)',
          borderBottom: '1px solid var(--line)',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--tx3)',
        }}
      >
        <div>{t('today.columnTask')}</div>
        <div>{t('today.columnProject')}</div>
        <div>{t('today.columnStarted')}</div>
        <div style={{ textAlign: 'right' }}>{t('today.columnRequests')}</div>
        <div style={{ textAlign: 'right' }}>{t('today.columnTokens')}</div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          padding: '4px 12px',
          minHeight: 0,
        }}
      >
        <TaskRows
          tasks={visible}
          maxTokens={maxTokens}
          expandedSessionId={expandedSessionId}
          taskCard={taskCard}
          {...(live === undefined ? {} : { live })}
          onToggle={handleToggle}
        />
        {folded === null ? null : (
          <FoldedTail count={tasks.length - folded.from} belowTokens={folded.belowTokens} />
        )}
      </div>
    </>
  )
}
