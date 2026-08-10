import type { LimitReportRow, Provider } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import { plural } from '../format.ts'
import { WindowLimit } from './WindowLimit.tsx'
import { WindowTabs, type WindowTab } from './WindowTabs.tsx'

export interface WindowHeaderProps {
  snapshot: TraySnapshot
  activeTab: WindowTab
  onTabChange: (tab: WindowTab) => void
}

function providerLimits(limits: LimitReportRow[]): LimitReportRow[] {
  const selected = new Map<Provider, LimitReportRow>()
  for (const limit of limits) {
    const current = selected.get(limit.provider)
    if (
      current === undefined ||
      (limit.usedPercent !== null &&
        (current.usedPercent === null || limit.usedPercent > current.usedPercent))
    ) {
      selected.set(limit.provider, limit)
    }
  }
  // Порядок задан, а не унаследован от данных: иначе CL и CX меняются местами
  // от снимка к снимку, и глаз каждый раз ищет свою цифру заново.
  return ORDER.filter((provider) => selected.has(provider)).map((provider) => selected.get(provider)!)
}

const ORDER: readonly Provider[] = ['claude', 'codex']

export function WindowHeader({ snapshot, activeTab, onTabChange }: WindowHeaderProps) {
  const active = snapshot.agents.filter((agent) => agent.state !== 'done').length
  const limits = providerLimits(snapshot.limits)

  return (
    <header
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 16px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--s1)',
        boxSizing: 'border-box',
      }}
    >
      <WindowTabs active={activeTab} onChange={onTabChange} />
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--ok)',
              animation: 'am-pulse 1.6s ease-in-out infinite',
            }}
          />
          {plural(active, ['активный', 'активных', 'активных'])}
        </div>
        {limits.map((limit) => (
          <WindowLimit key={`${limit.provider}-${limit.kind}-${limit.startsAt}`} limit={limit} />
        ))}
      </div>
    </header>
  )
}
