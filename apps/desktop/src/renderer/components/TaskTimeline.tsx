import type { Provider } from '@agentmeter/core'
import type { TimelinePoint } from '@agentmeter/ipc'
import { clock } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

export interface TaskTimelineProps {
  timeline: TimelinePoint[]
  timelineNote?: string
  provider: Provider
}

export function TaskTimeline({ timeline, timelineNote, provider }: TaskTimelineProps) {
  if (timeline.length === 0) return null
  const maximum = Math.max(0, ...timeline.map(({ tokens }) => tokens))

  return (
    <div
      data-task-timeline=""
      style={{
        padding: '18px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        borderBottom: '1px solid var(--line)',
      }}
    >
      <SectionTitle title="Таймлайн запросов · высота = токены запроса" />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 64 }}>
        {timeline.map((point, index) => (
          <div
            key={`${point.ts}:${index}`}
            data-timeline-point={index}
            title={point.note}
            style={{
              flex: 1,
              minWidth: 0,
              height: `${maximum === 0 ? 0 : (point.tokens / maximum) * 100}%`,
              background: point.note === undefined ? `var(--${provider})` : 'var(--alarm)',
            }}
          />
        ))}
      </div>
      <div
        data-timeline-caption=""
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          color: 'var(--tx3)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{clock(timeline[0]!.ts)}</span>
        <span style={{ color: 'var(--alarm)' }}>{timelineNote ?? ''}</span>
        <span>{clock(timeline.at(-1)!.ts)}</span>
      </div>
    </div>
  )
}
