import type { Config } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { Switch } from './Switch.tsx'

/**
 * «Приватность» — тот же блок тумблеров, строки 1185–1192 макета.
 *
 * Оба переключателя правят **данные**, а не показ: скрытые промпты не уезжают
 * из main в окно вовсе, скрытые пути не попадают в карточку (`main/day.ts`,
 * `main/task.ts`). Спрячь их в рендерере — и текст промпта продолжал бы ездить
 * по IPC и лежать в памяти окна, а настройка называлась бы «не рисовать».
 *
 * Число затронутых файлов при этом остаётся: это расход, а не содержимое.
 *
 * Сам тумблер с 5.3 живёт в `Switch.tsx`: переключателей стало три в двух
 * разделах, и вторая геометрия того же элемента разъехалась бы с первой молча.
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
