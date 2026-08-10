import type { HourBucket } from '@agentmeter/ipc'

export interface HourChartProps {
  hours: HourBucket[]
}

function hourRange(hours: HourBucket[]): number[] {
  const first = hours[0]?.hour
  const last = hours.at(-1)?.hour
  if (first === undefined || last === undefined || last < first) return []
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

export function HourChart({ hours }: HourChartProps) {
  const buckets = new Map(hours.map((bucket) => [bucket.hour, bucket]))
  const range = hourRange(hours)
  const maximum = Math.max(0, ...hours.map((bucket) => bucket.total))
  const labels = [...new Set([range[0], range[Math.floor(range.length / 2)], range.at(-1)])].filter(
    (hour): hour is number => hour !== undefined,
  )

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 78 }}>
        {range.map((hour) => (
          <div
            key={hour}
            data-hour={hour}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              gap: 1,
              height: '100%',
            }}
          >
            {buckets.get(hour)?.slices.map((slice) => (
              <div
                key={slice.provider}
                data-hour-slice={slice.provider}
                style={{
                  background: `var(--${slice.provider})`,
                  height: `${maximum === 0 ? 0 : (slice.tokens / maximum) * 100}%`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          color: 'var(--tx3)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {labels.map((hour) => (
          <span key={hour}>{String(hour).padStart(2, '0')}</span>
        ))}
      </div>
    </>
  )
}
