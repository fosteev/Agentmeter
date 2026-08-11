import type { DayReport, LiveAgent, TaskCard, TodayFilter } from '@agentmeter/ipc'
import { DaySummary } from './DaySummary.tsx'
import { TaskTable, type LiveAgents } from './TaskTable.tsx'
import { TodayFilters } from './TodayFilters.tsx'
import { t } from '../format.ts'

export interface TodayTabProps {
  report: DayReport | null
  filter: TodayFilter
  onFilterChange: (filter: TodayFilter) => void
  taskCard?: TaskCard | null
  /** Живые агенты из снимка трея — вход живой подписи в ленте (6.1). */
  agents?: readonly LiveAgent[]
  onTaskToggle?: (sessionId: string) => void
}

/**
 * Живые агенты по сессиям — только те, кто ещё работает.
 *
 * Завершившихся здесь нет намеренно: в попапе их строка держится выдержкой ради
 * «завершился 2 мин назад», а в ленте закончившаяся задача — самая обычная, и
 * она уже описана своей строкой целиком. Тем же правилом их не закрепляет
 * наверху main (`rememberLive`), так что оба конца соединения смотрят на одно и
 * то же множество.
 */
export function liveAgents(agents: readonly LiveAgent[]): LiveAgents {
  return new Map(
    agents.filter((agent) => agent.state !== 'done').map((agent) => [agent.sessionId, agent]),
  )
}

function emptyMessage(report: DayReport): string | null {
  if (report.emptyIndex) return t('today.emptyIndex')
  if (report.emptyDay) return t('today.emptyDay')
  if (report.tasks.length === 0) return t('today.emptyFilter')
  return null
}

export function TodayTab({
  report,
  filter,
  onFilterChange,
  taskCard = null,
  agents = [],
  onTaskToggle = () => undefined,
}: TodayTabProps) {
  const message = report === null ? t('today.loading') : emptyMessage(report)
  const live = liveAgents(agents)
  // Закреплено ли что-нибудь — по строкам ленты, а не по снимку: подпись
  // говорит о **порядке списка**, а его задал main, когда ленту собирал.
  // Агент, появившийся секунду назад, наверху ещё не стоит.
  const pinned = report?.tasks.some((task) => task.live === true) === true

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
      <TodayFilters filter={filter} onChange={onFilterChange} pinned={pinned} />
      {message === null ? (
        <TaskTable
          tasks={report!.tasks}
          folded={report!.folded}
          taskCard={taskCard}
          live={live}
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
