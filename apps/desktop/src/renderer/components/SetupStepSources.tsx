import type { SetupScan } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SetupHeading } from './SetupFrame.tsx'
import { SetupProviderCard } from './SetupProviderCard.tsx'

/**
 * Шаг 1 мастера — «Что мониторим», строки 1830–1895 макета.
 *
 * Показ найденного, без единого контрола: тумблеры провайдеров, Kimi CLI,
 * Ollama и «указать путь вручную» из макета сняты (бриф 7.3) — в конфиге нет
 * поля «провайдер включён», а пути в «Источниках» только показываются.
 *
 * Пока `setup:scan` не ответил, карточек нет вовсе: нарисовать «логи не
 * найдены» до того, как поискали, было бы враньём.
 */
export interface SetupStepSourcesProps {
  scan: SetupScan | null
}

export function SetupStepSources({ scan }: SetupStepSourcesProps) {
  const none = scan !== null && scan.providers.every((provider) => !provider.found)
  return (
    <div
      data-setup-step="1"
      style={{
        flex: 1,
        // Без этого тело шага растёт за раму, и рама обрезает его молча: смоук
        // меряет `scrollHeight` тела, а не окна.
        minHeight: 0,
        padding: '18px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        overflow: 'hidden',
      }}
    >
      <SetupHeading
        title={t('setup.sourcesTitle')}
        lede={none ? t('setup.sourcesNone') : t('setup.sourcesLede')}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {scan?.providers.map((provider) => (
          <SetupProviderCard key={provider.provider} scan={provider} />
        ))}
      </div>
    </div>
  )
}
