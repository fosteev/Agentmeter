import type { Provider } from '@agentmeter/core'
import type { SetupProviderScan } from '@agentmeter/ipc'
import { t } from '../format.ts'

/**
 * Карточка провайдера на первом шаге мастера — строки 1839–1857 и 1876–1884.
 *
 * Показ, а не настройка: тумблера «провайдер включён» нет, потому что в конфиге
 * нет такого поля (его снял бриф 7.3). Найденный провайдер — зелёная строка с
 * путём, числом файлов и размером и чипы моделей из индекса; ненайденный —
 * серая карточка со словами «логи не найдены в …» и путём, где искали.
 *
 * Модели не зашиты списком: чипы рисуются по тому, что проход уже разобрал. Пока
 * он не дошёл ни до одного запроса — слова «модели появятся после чтения
 * логов», а не пустая строка: пустое читалось бы как «моделей нет».
 */
export interface SetupProviderCardProps {
  scan: SetupProviderScan
}

const MONO = "'IBM Plex Mono', monospace"
const NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
const SHORT: Record<Provider, string> = { claude: 'CL', codex: 'CX' }
/** Сколько чипов моделей помещается в карточку в две строки; остальное — «+N». */
export const MODEL_CHIPS = 8

/**
 * Мегабайты одной цифрой после запятой — так же, как в разделе «Источники»:
 * мастер и настройки показывают один и тот же счёт одних и тех же файлов.
 */
export function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

export function SetupProviderCard({ scan }: SetupProviderCardProps) {
  const { provider } = scan
  const badge = (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--bg)',
        background: `var(--${provider})`,
        borderRadius: 3,
        padding: '2px 5px',
        textAlign: 'center',
      }}
    >
      {SHORT[provider]}
    </span>
  )

  if (!scan.found) {
    return (
      <div
        data-setup-provider={provider}
        data-setup-found="false"
        style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr',
          gap: 11,
          alignItems: 'center',
          padding: '10px 14px',
          border: '1px solid var(--line)',
          borderRadius: 8,
        }}
      >
        {badge}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--tx2)' }}>{NAME[provider]}</span>
          <span style={{ ...PATH_LINE, color: 'var(--tx3)' }}>
            {t('setup.sourceMissing', { path: scan.path })}
          </span>
        </div>
      </div>
    )
  }

  const shown = scan.models.slice(0, MODEL_CHIPS)
  const more = scan.models.length - shown.length
  return (
    <div
      data-setup-provider={provider}
      data-setup-found="true"
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--s1)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr',
          gap: 11,
          alignItems: 'center',
          padding: '11px 14px',
        }}
      >
        {badge}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{NAME[provider]}</span>
          <span style={{ ...PATH_LINE, color: 'var(--ok)' }}>
            {t('setup.sourceFound', {
              path: scan.path,
              files: t('settings.files', { count: scan.files }),
              size: t('settings.megabytes', { value: megabytes(scan.bytes) }),
            })}
          </span>
        </div>
      </div>
      <div
        style={{
          borderTop: '1px solid var(--line)',
          padding: '8px 14px 9px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          {t('setup.modelsTitle')}
        </span>
        {shown.length === 0 ? (
          <span data-setup-models="empty" style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--tx3)' }}>
            {t('setup.modelsEmpty')}
          </span>
        ) : (
          <div
            data-setup-models={provider}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 5, fontFamily: MONO, fontSize: 11 }}
          >
            {shown.map((model) => (
              <span
                key={model}
                data-setup-model={model}
                style={{
                  padding: '4px 9px',
                  borderRadius: 5,
                  background: 'var(--s2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{ width: 5, height: 5, borderRadius: 1, background: `var(--${provider})` }}
                />
                {model}
              </span>
            ))}
            {more > 0 ? (
              <span style={{ padding: '4px 9px', borderRadius: 5, color: 'var(--tx3)', border: '1px solid var(--line)' }}>
                {t('setup.modelsMore', { count: more })}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

const PATH_LINE = {
  fontFamily: MONO,
  fontSize: 10.5,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const
