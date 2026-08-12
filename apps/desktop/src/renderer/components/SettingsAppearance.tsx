import type { Config } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { languageName, t } from '../format.ts'

/**
 * «Внешний вид» — блок тумблеров и темы, строки 1236–1243 макета.
 *
 * Язык рядом с темой, а не отдельным разделом: обе настройки меняют то, как
 * выглядит и читается уже открытое окно, и обе применяются без перезапуска.
 * Пунктов языка три, и «системный» — не украшение: до 3.8 в конфиге лежало
 * зашитое `ru`, и человек с английской системой видел русский интерфейс, не
 * имея способа догадаться, откуда он взялся.
 */
export interface SettingsAppearanceProps {
  config: Config
  onChange: (patch: DeepPartial<Config>) => void
}

const THEMES: ReadonlyArray<{ value: Config['ui']['theme']; key: string }> = [
  { value: 'dark', key: 'settings.themeDark' },
  { value: 'light', key: 'settings.themeLight' },
  { value: 'system', key: 'settings.themeSystem' },
]

const LOCALES: ReadonlyArray<{ value: Config['ui']['locale']; key?: string; name?: 'ru' | 'en' }> = [
  { value: 'system', key: 'settings.languageSystem' },
  { value: 'ru', name: 'ru' },
  { value: 'en', name: 'en' },
]

export function SettingsAppearance({ config, onChange }: SettingsAppearanceProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        borderTop: '1px solid var(--line)',
        paddingTop: 16,
      }}
    >
      <div style={ROW}>
        <span style={{ fontSize: 12.5 }}>{t('settings.theme')}</span>
        <div style={CHIPS}>
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              data-theme-choice={theme.value}
              aria-pressed={config.ui.theme === theme.value}
              onClick={() => onChange({ ui: { theme: theme.value } })}
              style={chip(config.ui.theme === theme.value)}
            >
              {t(theme.key as 'settings.themeDark')}
            </button>
          ))}
        </div>
      </div>

      <div style={ROW}>
        <span style={{ fontSize: 12.5 }}>{t('settings.language')}</span>
        <div style={CHIPS}>
          {LOCALES.map((item) => (
            <button
              key={item.value}
              type="button"
              data-locale-choice={item.value}
              aria-pressed={config.ui.locale === item.value}
              onClick={() => onChange({ ui: { locale: item.value } })}
              style={chip(config.ui.locale === item.value)}
            >
              {/* Имя языка — на нём самом: его ищет тот, кто текущего не понял. */}
              {item.name === undefined
                ? t(item.key as 'settings.languageSystem')
                : languageName(item.name)}
            </button>
          ))}
        </div>
      </div>

      <div style={ROW}>
        <span style={{ fontSize: 12.5 }}>{t('settings.dayStart')}</span>
        <div style={CHIPS}>
          <select
            data-setting="dayStartsAtHour"
            aria-label={t('settings.dayStart')}
            value={config.ui.dayStartsAtHour}
            onChange={(event) =>
              onChange({ ui: { dayStartsAtHour: Number(event.currentTarget.value) } })
            }
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--tx)',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={hour}>
                {t('settings.hour', { hour: String(hour).padStart(2, '0') })}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

const ROW = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
} as const

const CHIPS = {
  display: 'flex',
  gap: 4,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
} as const

function chip(selected: boolean) {
  return {
    padding: '4px 9px',
    border: 0,
    borderRadius: 5,
    font: 'inherit',
    cursor: 'pointer',
    background: selected ? 'var(--s2)' : 'transparent',
    color: selected ? 'var(--tx)' : 'var(--tx2)',
  } as const
}
