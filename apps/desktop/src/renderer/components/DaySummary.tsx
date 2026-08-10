import type { DayReport } from '@agentmeter/ipc'
import { dayTitle, formatTokens, t } from '../format.ts'

export interface DaySummaryProps {
  report: DayReport
}

export function DaySummary({ report }: DaySummaryProps) {
  const { totals } = report
  const approximate = totals.total.confidence !== 'exact'

  return (
    <div
      style={{
        padding: '18px 24px 12px',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, minWidth: 0 }}>
        <span style={{ fontSize: 20, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {dayTitle(report.range.from)}
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            color: 'var(--tx2)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {t('today.sessions', { count: totals.sessions })} ·{' '}
          {t('today.projectsPlain', { count: totals.projects })} ·{' '}
          {t('today.requests', { count: totals.requests })}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          title={totals.total.caveat}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 22,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {approximate ? '≈' : ''}
          {formatTokens(totals.total.value)}
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx3)',
          }}
        >
          {t('today.tokensWord')}
        </span>
      </div>
    </div>
  )
}
