import type { DayReport, TaskCard, TodayFilter } from '@agentmeter/ipc'
import { DaySummary } from './DaySummary.tsx'
import { TaskTable } from './TaskTable.tsx'
import { TodayFilters } from './TodayFilters.tsx'

export interface TodayTabProps {
  report: DayReport | null
  filter: TodayFilter
  onFilterChange: (filter: TodayFilter) => void
  taskCard?: TaskCard | null
  onTaskToggle?: (sessionId: string) => void
}

function emptyMessage(report: DayReport): string | null {
  if (report.emptyIndex) return 'Первичное индексирование — лента появится после чтения логов'
  if (report.emptyDay) return 'Сегодня задач не было'
  if (report.tasks.length === 0) return 'По выбранному фильтру задач нет'
  return null
}

export function TodayTab({
  report,
  filter,
  onFilterChange,
  taskCard = null,
  onTaskToggle = () => undefined,
}: TodayTabProps) {
  const message = report === null ? 'Загружаем ленту…' : emptyMessage(report)

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: '1px solid var(--line)',
      }}
    >
      {/*
        Пока индекс не прочитан, итога дня нет — есть незнание. Нули в шапке
        («0 сессий · 0 запросов · 0 токенов») были бы утверждением, и ложным:
        логи на диске лежат, их просто ещё не разобрали. Пустой день — другое
        дело, там нули правда.
      */}
      {report === null || report.emptyIndex ? null : <DaySummary report={report} />}
      <TodayFilters filter={filter} onChange={onFilterChange} />
      {message === null ? (
        <TaskTable
          tasks={report!.tasks}
          folded={report!.folded}
          taskCard={taskCard}
          onToggle={onTaskToggle}
        />
      ) : (
        <div
          role="status"
          style={{
            flex: 1,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--tx3)',
          }}
        >
          {message}
        </div>
      )}
    </section>
  )
}
