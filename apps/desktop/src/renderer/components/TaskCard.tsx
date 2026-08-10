import type { TaskCard as TaskCardData } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { BreakdownRow } from './BreakdownRow.tsx'
import { TaskCardHeader } from './TaskCardHeader.tsx'
import { TaskFiles } from './TaskFiles.tsx'
import { SectionTitle } from './SectionTitle.tsx'
import { TaskTimeline } from './TaskTimeline.tsx'
import { TokenSplit } from './TokenSplit.tsx'

/**
 * Поля обеих колонок нижней сетки живут здесь, а не внутри `TokenSplit` и
 * списка инструментов: числа приходят из блоков сетки макета (строки 867 и
 * 884), и числовая приёмка сверяет их с блоком того компонента, в чьём коде они
 * написаны. Общая константа на две колонки прятала бы половину чисел от
 * проверки, которой они и принадлежат.
 */
const COLUMN = {
  padding: '18px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
} as const

export function TaskCard({ card }: { card: TaskCardData }) {
  const maximum = Math.max(0, ...card.tools.map(({ marginal }) => marginal.value))

  return (
    <div
      data-task-card={card.task.sessionId}
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: `inset 3px 0 0 var(--${card.task.provider})`,
      }}
    >
      <TaskCardHeader card={card} />
      <TaskTimeline
        timeline={card.timeline}
        provider={card.task.provider}
        {...(card.timelineNote === undefined ? {} : { timelineNote: card.timelineNote })}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 0 }}>
        <div data-token-split="" style={{ ...COLUMN, borderRight: '1px solid var(--line)' }}>
          <TokenSplit tokens={card.tokens} note={card.note} />
        </div>
        <div style={COLUMN}>
          <SectionTitle title={t('card.tools')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {card.tools.map((tool) => (
              <BreakdownRow
                key={tool.key}
                label={tool.label}
                tokens={tool.marginal.value}
                max={maximum}
                persistent={false}
                variant="task"
                calls={tool.calls}
                confidence={tool.marginal.confidence}
                {...(tool.marginal.caveat === undefined ? {} : { caveat: tool.marginal.caveat })}
                {...(tool.note === undefined ? {} : { note: tool.note })}
              />
            ))}
          </div>
          <TaskFiles files={card.files} />
        </div>
      </div>
    </div>
  )
}
