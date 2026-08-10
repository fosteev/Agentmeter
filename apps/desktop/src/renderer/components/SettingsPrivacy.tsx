import type { Config } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { t } from '../format.ts'

/**
 * «Приватность» — тот же блок тумблеров, строки 1185–1192 макета.
 *
 * Оба переключателя правят **данные**, а не показ: скрытые промпты не уезжают
 * из main в окно вовсе, скрытые пути не попадают в карточку (`main/day.ts`,
 * `main/task.ts`). Спрячь их в рендерере — и текст промпта продолжал бы ездить
 * по IPC и лежать в памяти окна, а настройка называлась бы «не рисовать».
 *
 * Число затронутых файлов при этом остаётся: это расход, а не содержимое.
 */
export interface SettingsPrivacyProps {
  config: Config
  onChange: (patch: DeepPartial<Config>) => void
}

export function SettingsPrivacy({ config, onChange }: SettingsPrivacyProps) {
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
      <Switch
        name="hidePrompts"
        label={t('settings.hidePrompts')}
        note={t('settings.hidePromptsNote')}
        checked={config.privacy.hidePrompts}
        onChange={(value) => onChange({ privacy: { hidePrompts: value } })}
      />
      <Switch
        name="hidePaths"
        label={t('settings.hidePaths')}
        note={t('settings.hidePathsNote')}
        checked={config.privacy.hidePaths}
        onChange={(value) => onChange({ privacy: { hidePaths: value } })}
      />
    </div>
  )
}

function Switch({
  name,
  label,
  note,
  checked,
  onChange,
}: {
  name: string
  label: string
  note: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12.5 }}>
        {label} <span style={{ color: 'var(--tx3)', fontSize: 11.5 }}>{note}</span>
      </span>
      <span
        style={{
          width: 34,
          height: 19,
          borderRadius: 10,
          background: checked ? 'var(--ok)' : 'var(--s2)',
          position: 'relative',
          flex: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            ...(checked ? { right: 2 } : { left: 2 }),
            top: 2,
            width: 15,
            height: 15,
            borderRadius: '50%',
            background: checked ? 'var(--bg)' : 'var(--tx3)',
          }}
        />
        <input
          type="checkbox"
          data-setting={name}
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          style={{ position: 'absolute', inset: 0, margin: 0, opacity: 0, cursor: 'pointer' }}
        />
      </span>
    </label>
  )
}
