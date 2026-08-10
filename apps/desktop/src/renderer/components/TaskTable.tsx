import type { FoldedTail as FoldedTailData, TaskRow } from '@agentmeter/ipc'
import { FoldedTail } from './FoldedTail.tsx'
import { TaskLine } from './TaskLine.tsx'

export interface TaskTableProps {
  tasks: TaskRow[]
  folded: FoldedTailData | null
}

export function TaskTable({ tasks, folded }: TaskTableProps) {
  const visible = folded === null ? tasks : tasks.slice(0, folded.from)
  const maxTokens = Math.max(0, ...tasks.map((task) => task.tokens.value))

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
        <div>Задача</div>
        <div>Проект · ветка</div>
        <div>Начало</div>
        <div style={{ textAlign: 'right' }}>Запросы</div>
        <div style={{ textAlign: 'right' }}>Токены</div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          padding: '4px 12px',
          minHeight: 0,
        }}
      >
        {visible.map((task) => (
          <TaskLine key={task.sessionId} task={task} maxTokens={maxTokens} />
        ))}
        {folded === null ? null : (
          <FoldedTail count={tasks.length - folded.from} belowTokens={folded.belowTokens} />
        )}
      </div>
    </>
  )
}
