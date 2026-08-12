import type { LiveAgent, TaskCard as TaskCardData } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { BreakdownRow } from './BreakdownRow.tsx'
import { TaskCardHeader } from './TaskCardHeader.tsx'
import { TaskFiles } from './TaskFiles.tsx'
import { SectionTitle } from './SectionTitle.tsx'
import { TaskLive } from './TaskLive.tsx'
import { TaskSubagents } from './TaskSubagents.tsx'
import { TaskTimeline } from './TaskTimeline.tsx'
import { TokenSplit } from './TokenSplit.tsx'

/**
 * Поля обеих колонок нижней сетки живут здесь, а не внутри `TokenSplit` и
 * списка инструментов: числа приходят из блоков сетки макета (строки 906 и
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

export function TaskCard({ card, live }: { card: TaskCardData; live?: LiveAgent | undefined }) {
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
      {/*
        Текущий ход — сразу под шапкой и до таймлайна (6.1): всё, что ниже,
        рассказывает про уже случившееся, а это единственная строка карточки про
        происходящее. Вопрос здесь целиком, а в ленте он же обрезан по ширине
        колонки — раскрывают карточку в том числе затем, чтобы дочитать.
      */}
      {live === undefined ? null : (
        <div
          data-task-card-live
          style={{ padding: '10px 22px', borderTop: '1px solid var(--line)' }}
        >
          <TaskLive agent={live} density="card" />
        </div>
      )}
      <TaskTimeline
        timeline={card.timeline}
        provider={card.task.provider}
        {...(card.timelineNote === undefined ? {} : { timelineNote: card.timelineNote })}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 0 }}>
        <div data-token-split="" style={{ ...COLUMN, borderRight: '1px solid var(--line)' }}>
          <TokenSplit tokens={card.tokens} note={card.note} />
          {/*
            Одна строка, без гистограммы и без итогов дня — решение дизайна
            (макет, строки 1788–1791): переплата за паузу это свойство того, как
            идёт день, а не задачи. Гистограмма живёт в «Развёртке».
          */}
          {card.rebuilds === undefined ? null : (
            <div data-task-rebuilds style={{ fontSize: 11.5, color: 'var(--tx2)' }}>
              {t('rebuild.card', {
                count: card.rebuilds.count,
                tokens: `${card.rebuilds.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(card.rebuilds.tokens.value)}`,
              })}
            </div>
          )}
          <TaskSubagents {...(card.task.children === undefined ? {} : { children: card.task.children })} />
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
