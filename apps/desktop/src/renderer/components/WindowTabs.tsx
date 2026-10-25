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
  { id: 'workflow', labelKey: 'window.tabWorkflow', stage: '9.5' },
  { id: 'settings', labelKey: 'window.tabSettings', stage: '3.6' },
]

type TabLabelKey =
  | 'window.tabToday'
  | 'window.tabBreakdown'
  | 'window.tabHistory'
  | 'window.tabWorkflow'
  | 'window.tabSettings'

/**
 * Вкладки, которые видно (9.5). «Workflow» есть только при включённом экране
 * (`config.workflow.enabled`): тем, кто не гоняет сабагентов, пустая вкладка
 * только мешает. Список в `WINDOW_TABS` остаётся полным — по нему окно узнаёт
 * вкладку из адреса, а выключенную поймает уже само.
 */
export function visibleTabs(workflow: boolean): typeof WINDOW_TABS {
  return WINDOW_TABS.filter((tab) => tab.id !== 'workflow' || workflow)
}

export interface WindowTabsProps {
  active: WindowTab
  onChange: (tab: WindowTab) => void
  /** Экран Workflow включён в настройках. Без него четвёртой вкладки нет. */
  workflow?: boolean
}

export function WindowTabs({ active, onChange, workflow = false }: WindowTabsProps) {
  return (
    <div style={{ display: 'flex', gap: 2, marginLeft: 12 }}>
      {visibleTabs(workflow).map((tab) => {
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
              // `transparent`, а не пропуск свойства: у `button` без фона
              // Chromium рисует свой `buttonface` — светло-серый, и в тёмной
              // теме невыбранные вкладки выглядят подсвеченными сильнее
              // выбранной. Ровно поэтому все остальные кнопки окна тоже пишут
              // фон явно.
              background: selected ? 'var(--s2)' : 'transparent',
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
