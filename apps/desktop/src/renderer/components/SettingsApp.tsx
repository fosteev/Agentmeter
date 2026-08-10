import type { Config } from '@agentmeter/core'
import type { DeepPartial, StartupStatus, UpdateStatus } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { Switch } from './Switch.tsx'

/**
 * «Приложение» — автозапуск (5.3) и обновления (5.4).
 *
 * Своим разделом, а не строкой во «Внешнем виде»: там живёт то, как выглядит и
 * читается **уже открытое** окно, а здесь — будет ли приложение открыто вообще
 * и какой версии.
 *
 * Оба тумблера устроены не как соседи по настройкам. Автозапуск читается у
 * операционной системы, а не из конфига: человек снимает его системными
 * средствами, и наша копия ответа разошлась бы с правдой молча. Проверка
 * обновлений — наоборот, настоящая настройка, но с последствием, которого нет
 * больше ни у одной: это единственный сетевой вызов продукта, и подпись
 * говорит именно это.
 *
 * Кнопка тут ровно одна и меняется по фазе: «Проверить» — пока проверять есть
 * смысл, «Установить и перезапустить» — когда скачано. Кнопки «Скачать» нет:
 * загрузка идёт сама, и лишний шаг был бы выдуманным.
 */
export interface SettingsAppProps {
  config: Config
  startup: StartupStatus
  update: UpdateStatus
  onChange: (patch: DeepPartial<Config>) => void
  onToggleStartup: (enabled: boolean) => void
  onCheckUpdate: () => void
  onInstallUpdate: () => void
}

export function SettingsApp({
  config,
  startup,
  update,
  onChange,
  onToggleStartup,
  onCheckUpdate,
  onInstallUpdate,
}: SettingsAppProps) {
  const busy = update.phase === 'checking' || update.phase === 'downloading'
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
        onChange={onToggleStartup}
      />

      <Switch
        name="updatesAuto"
        label={t('settings.updateAuto')}
        note={t('settings.updateAutoNote')}
        checked={config.updates.auto}
        disabled={update.phase === 'unsupported'}
        onChange={(value) => onChange({ updates: { auto: value } })}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12.5 }}>
          {t('settings.version')}{' '}
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              color: 'var(--tx2)',
            }}
          >
            {update.current}
          </span>{' '}
          <span style={{ color: 'var(--tx3)', fontSize: 11.5 }} data-update-state={update.phase}>
            {statusText(update)}
          </span>
        </span>
        {update.phase === 'ready' ? (
          <button type="button" data-update-action="install" onClick={onInstallUpdate} style={CHIP}>
            {t('settings.updateInstall')}
          </button>
        ) : update.phase === 'unsupported' ? null : (
          <button
            type="button"
            data-update-action="check"
            disabled={busy}
            onClick={onCheckUpdate}
            style={{ ...CHIP, opacity: busy ? 0.5 : 1 }}
          >
            {t('settings.updateCheck')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Что написано рядом с версией.
 *
 * Фраза собирается здесь, а не в main, потому что суждения в ней нет: это
 * подстановка приехавших полей в постоянный шаблон (правило 3.0). Ошибка при
 * этом показывается **дословно** от загрузчика — пересказ «что-то пошло не
 * так» отнял бы у человека единственную зацепку.
 */
function statusText(update: UpdateStatus): string {
  switch (update.phase) {
    case 'unsupported':
      return t('settings.updateUnsupported')
    case 'off':
      return t('settings.updateOff')
    case 'checking':
      return t('settings.updateChecking')
    case 'downloading':
      return t('settings.updateDownloading', {
        version: update.version ?? '',
        percent: update.percent ?? 0,
      })
    case 'ready':
      return t('settings.updateReady', { version: update.version ?? '' })
    case 'error':
      return t('settings.updateError', { message: update.error ?? '' })
    default:
      return t('settings.updateIdle')
  }
}

const CHIP = {
  padding: '4px 9px',
  border: 0,
  borderRadius: 5,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
  cursor: 'pointer',
  background: 'var(--s2)',
  color: 'var(--tx)',
} as const
