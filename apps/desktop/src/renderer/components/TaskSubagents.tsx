import type { TaskRow } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

/**
 * Из кого сложилась задача — блок «Сабагенты» карточки (3.5).
 *
 * В макете такого блока нет: сабагенты в нём не нарисованы вовсе. Место выбрано
 * по смыслу соседей — слева в карточке стоят виды токенов, то есть **из чего**
 * состоит расход, и список участников отвечает на тот же вопрос другим срезом.
 * Свёрстано теми же числами, что блок «Затронутые файлы» справа.
 *
 * Строка ребёнка не кликается, и это решение: карточка родителя уже собрана по
 * всему дереву (3.4) — таймлайн, инструменты и файлы включают запросы детей.
 * Вторая карточка показала бы те же столбики подмножеством первой.
 */
export function TaskSubagents({ children }: { children?: TaskRow[] }) {
  if (children === undefined || children.length === 0) return null

  return (
    <div
      data-task-subagents=""
      style={{
        borderTop: '1px solid var(--line)',
        paddingTop: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <SectionTitle title={t('card.subagents', { count: children.length })} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {children.map((child) => (
          <div
            key={child.sessionId}
            data-subagent-row={child.sessionId}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10.5,
            }}
          >
            <span
              style={{
                color: 'var(--tx2)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {child.agentType ?? t('card.subagentUnnamed')}
            </span>
            <span style={{ color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
              {t('today.requests', { count: child.requests })}
            </span>
            <span
              title={child.tokens.caveat}
              style={{
                flex: 'none',
                color: 'var(--tx)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {child.tokens.confidence === 'exact' ? '' : '≈'}
              {formatTokens(child.tokens.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
