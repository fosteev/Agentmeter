import type { Provider, TaskRow as TaskRowData } from '@agentmeter/core'
import { formatTokens } from '../format.ts'

// Строка задачи. Состояния из строк 185–190 макета:
// обычная (без фона) · наведение (s2) · раскрыта (s2 + inset-акцент 2px слева,
// цветом провайдера) · без названия (italic tx2, opacity .5). Наполняется
// типом TaskRow из packages/core/src/query/types.ts. Высота строки списка
// (44 в окне / 40 в попапе) — забота родительского списка в 3.1, компонент
// её не задаёт.

export interface TaskRowProps {
  task: TaskRowData
  hover?: boolean
  expanded?: boolean
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

export function TaskRow({ task, hover, expanded }: TaskRowProps) {
  const untitled = task.title === null || task.title.length === 0
  const raised = hover === true || expanded === true

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '8px 10px',
        borderRadius: 'var(--r-inner)',
        background: raised ? 'var(--s2)' : 'transparent',
        boxShadow: expanded ? `inset 2px 0 0 ${ACCENT[task.provider]}` : undefined,
        opacity: untitled ? 0.5 : 1,
      }}
    >
      <span
        style={
          untitled ? { fontSize: 13, fontStyle: 'italic', color: 'var(--tx2)' } : { fontSize: 13 }
        }
      >
        {untitled ? 'без названия' : task.title}
      </span>
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          color: 'var(--tx2)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatTokens(task.totals.total)}
      </span>
    </div>
  )
}
