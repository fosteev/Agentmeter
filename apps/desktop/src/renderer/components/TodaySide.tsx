import type { DayReport } from '@agentmeter/ipc'
import { HourChart } from './HourChart.tsx'
import { ProjectBars } from './ProjectBars.tsx'
import { SectionTitle } from './SectionTitle.tsx'
import { SpendBar } from './SpendBar.tsx'
import { t } from '../format.ts'

export interface TodaySideProps {
  report: DayReport | null
  /** Переход на «Развёртку» из подписи под полосой (строка 777 макета). */
  onOpenBreakdown?: () => void
}

export function TodaySide({ report, onOpenBreakdown }: TodaySideProps) {
  const showHours = report !== null && !report.emptyIndex && report.byHour.length > 0
  const showProjects = report !== null && !report.emptyIndex && report.byProject.length > 0
  // Блока нет, когда тикетов нет: пустой список обещал бы разрез, которого за
  // этот день не существует (3.7).
  const tickets = report?.byTicket ?? []
  const showTickets = report !== null && !report.emptyIndex && tickets.length > 0
  // Тем же правилом, что тикеты: поля нет — блока нет. Пустая полоса «постоянное
  // против разового» обещала бы разложение, которого за этот день не считали.
  const split = report?.split
  const showSplit = report !== null && !report.emptyIndex && split !== undefined

  return (
    <aside
      data-today-side
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--s1)',
      }}
    >
      {showHours ? (
        <div
          data-today-side-block="hours"
          style={{ padding: '18px 18px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <SectionTitle title={t('today.byHour')} />
          <HourChart hours={report.byHour} />
        </div>
      ) : null}
      {showHours && showProjects ? (
        <div data-today-side-divider style={{ height: 1, background: 'var(--line)' }} />
      ) : null}
      {showProjects ? (
        <div
          data-today-side-block="projects"
          style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <SectionTitle title={t('today.byProject')} />
          <ProjectBars projects={report.byProject} />
        </div>
      ) : null}
      {showProjects && showTickets ? (
        <div data-today-side-divider style={{ height: 1, background: 'var(--line)' }} />
      ) : null}
      {showTickets ? (
        <div
          data-today-side-block="tickets"
          style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <SectionTitle title={t('today.byTicket')} />
          <ProjectBars projects={tickets} kind="ticket" />
        </div>
      ) : null}
      {(showProjects || showTickets) && showSplit ? (
        <div data-today-side-divider style={{ height: 1, background: 'var(--line)' }} />
      ) : null}
      {showSplit ? (
        <SpendBar split={split} {...(onOpenBreakdown ? { onOpenBreakdown } : {})} />
      ) : null}
    </aside>
  )
}
