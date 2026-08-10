import type { IpcCalls } from '@agentmeter/ipc'

export type WindowTab = IpcCalls['window:open']['arg']['tab']

export const WINDOW_TABS: ReadonlyArray<{ id: WindowTab; label: string; stage: string }> = [
  { id: 'today', label: 'Сегодня', stage: '3.2' },
  { id: 'breakdown', label: 'Развёртка', stage: '4.2' },
  { id: 'history', label: 'История', stage: '4.6' },
  { id: 'settings', label: 'Настройки', stage: '3.6' },
]

export interface WindowTabsProps {
  active: WindowTab
  onChange: (tab: WindowTab) => void
}

export function WindowTabs({ active, onChange }: WindowTabsProps) {
  return (
    <div style={{ display: 'flex', gap: 2, marginLeft: 12 }}>
      {WINDOW_TABS.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(tab.id)}
            style={{
              padding: '6px 12px',
              border: 0,
              borderRadius: 6,
              background: selected ? 'var(--s2)' : undefined,
              color: selected ? 'var(--tx)' : 'var(--tx2)',
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: selected ? 500 : undefined,
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
