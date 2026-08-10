import type { DayReport } from '@agentmeter/ipc'
import { HourChart } from './HourChart.tsx'
import { ProjectBars } from './ProjectBars.tsx'
import { SectionTitle } from './SectionTitle.tsx'
import { t } from '../format.ts'

export interface TodaySideProps {
  report: DayReport | null
}

export function TodaySide({ report }: TodaySideProps) {
  const showHours = report !== null && !report.emptyIndex && report.byHour.length > 0
  const showProjects = report !== null && !report.emptyIndex && report.byProject.length > 0

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
    </aside>
  )
}
