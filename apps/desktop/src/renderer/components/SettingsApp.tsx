import type { StartupStatus } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { Switch } from './Switch.tsx'

/**
 * «Приложение» — автозапуск при входе в систему (5.3), строка 1198 макета.
 *
 * Своим разделом, а не строкой во «Внешнем виде»: там живёт то, как выглядит и
 * читается **уже открытое** окно, а здесь — будет ли приложение открыто вообще.
 *
 * Тумблер устроен не как соседи: остальные настройки правят файл, этот —
 * операционную систему, и состояние приезжает **оттуда же**. Поэтому у него нет
 * поля в конфиге и нет «сохранено»: человек снимает автозапуск системными
 * средствами, и наша копия ответа разошлась бы с правдой молча.
 *
 * В неустановленном приложении тумблер выключен и подписан причиной. Спрятать
 * его было бы хуже: пропавшая настройка читается как «её тут нет», а не как
 * «здесь она не сработает».
 */
export interface SettingsAppProps {
  startup: StartupStatus
  onToggle: (enabled: boolean) => void
}

export function SettingsApp({ startup, onToggle }: SettingsAppProps) {
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
        name="launchAtLogin"
        label={t('settings.launchAtLogin')}
        note={startup.reason}
        checked={startup.enabled}
        disabled={!startup.available}
        onChange={onToggle}
      />
    </div>
  )
}
