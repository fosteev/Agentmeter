import type { IpcCalls } from '@agentmeter/ipc'
import { t } from '../format.ts'

export type WindowTab = IpcCalls['window:open']['arg']['tab']

/**
 * В списке лежит **ключ**, а не подпись.
 *
 * Разница не косметическая: список — константа модуля, и `t()` в нём посчитался
 * бы один раз при загрузке. Язык, сменённый после этого (3.6 меняет его без
 * перезапуска окна), не доехал бы до вкладок — и это единственное место в окне,
 * которое осталось бы на прежнем языке, причём самое заметное.
 */
export const WINDOW_TABS: ReadonlyArray<{ id: WindowTab; labelKey: TabLabelKey; stage: string }> = [
  { id: 'today', labelKey: 'window.tabToday', stage: '3.2' },
  { id: 'breakdown', labelKey: 'window.tabBreakdown', stage: '4.2' },
  { id: 'history', labelKey: 'window.tabHistory', stage: '4.6' },
  { id: 'settings', labelKey: 'window.tabSettings', stage: '3.6' },
]

type TabLabelKey =
  'window.tabToday' | 'window.tabBreakdown' | 'window.tabHistory' | 'window.tabSettings'

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
            {t(tab.labelKey)}
          </button>
        )
      })}
    </div>
  )
}
