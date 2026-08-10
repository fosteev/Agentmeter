import { useState } from 'react'
import type { Config } from '@agentmeter/core'
import type { ConfigReport, DeepPartial } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SettingsAlerts } from './SettingsAlerts.tsx'
import { SettingsApp } from './SettingsApp.tsx'
import { SettingsAppearance } from './SettingsAppearance.tsx'
import { SettingsLimits } from './SettingsLimits.tsx'
import { SettingsPrivacy } from './SettingsPrivacy.tsx'
import { SettingsSources } from './SettingsSources.tsx'

/**
 * Настройки — раздел 6 макета (строки 1119–1193).
 *
 * Пять разделов слева, содержимое справа. В макете правая колонка нарисована
 * сразу со всеми группами — это лист образцов, а не один экран: группы явно
 * принадлежат разным пунктам списка («Пути к логам» — источникам, «Потолки» —
 * лимитам, ползунки — уведомлениям). Поэтому каждая группа стоит в своём
 * разделе и свёрстана числами **своего** блока макета.
 *
 * Разделов стало шесть: в 5.3 приехал автозапуск, и он не про внешний вид и не
 * про приватность — он про то, будет ли приложение открыто вообще. Своё место
 * ему нужно ещё и потому, что состояние он берёт у операционной системы, а не
 * из файла настроек, — то есть правится другим каналом.
 */
export type SettingsSection = 'sources' | 'limits' | 'alerts' | 'appearance' | 'privacy' | 'app'

/** Ключи, а не подписи: `t()` на верхнем уровне застыл бы на языке загрузки. */
const SECTIONS: ReadonlyArray<{ id: SettingsSection; key: string }> = [
  { id: 'sources', key: 'settings.tabSources' },
  { id: 'limits', key: 'settings.tabLimits' },
  { id: 'alerts', key: 'settings.tabAlerts' },
  { id: 'appearance', key: 'settings.tabAppearance' },
  { id: 'privacy', key: 'settings.tabPrivacy' },
  { id: 'app', key: 'settings.tabApp' },
]

export interface SettingsTabProps {
  report: ConfigReport
  onChange: (patch: DeepPartial<Config>) => void
  /**
   * Переключить автозапуск. Отдельно от `onChange` намеренно: он пишет файл
   * настроек, а это — операционную систему (5.3).
   */
  onStartup: (enabled: boolean) => void
  /** С какого раздела открыть. Нужен витрине и тестам; по умолчанию первый. */
  section?: SettingsSection
}

export function SettingsTab({ report, onChange, onStartup, section = 'sources' }: SettingsTabProps) {
  const [active, setActive] = useState<SettingsSection>(section)
  const { config } = report

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        display: 'grid',
        gridTemplateColumns: '180px 1fr',
        minHeight: 0,
      }}
    >
      <div
        style={{
          background: 'var(--s1)',
          borderRight: '1px solid var(--line)',
          padding: '16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-settings-section={item.id}
            aria-pressed={active === item.id}
            onClick={() => setActive(item.id)}
            style={{
              padding: '7px 10px',
              border: 0,
              borderRadius: 6,
              textAlign: 'left',
              font: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
              background: active === item.id ? 'var(--s2)' : 'transparent',
              color: active === item.id ? 'var(--tx)' : 'var(--tx2)',
            }}
          >
            {t(item.key as 'settings.tabSources')}
          </button>
        ))}
      </div>

      <div
        data-settings-pane={active}
        style={{
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
          overflow: 'auto',
          minHeight: 0,
        }}
      >
        {active === 'sources' ? (
          <SettingsSources sources={report.sources} problems={report.problems} />
        ) : null}
        {active === 'limits' ? <SettingsLimits config={config} onChange={onChange} /> : null}
        {active === 'alerts' ? <SettingsAlerts config={config} onChange={onChange} /> : null}
        {active === 'appearance' ? (
          <SettingsAppearance config={config} onChange={onChange} />
        ) : null}
        {active === 'privacy' ? <SettingsPrivacy config={config} onChange={onChange} /> : null}
        {active === 'app' ? <SettingsApp startup={report.startup} onToggle={onStartup} /> : null}
      </div>
    </div>
  )
}
