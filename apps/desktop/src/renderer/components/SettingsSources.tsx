import type { SourceStatus } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

/**
 * «Пути к логам» — строки 1130–1144 макета.
 *
 * Раздел читающий: путь показывается, но не правится. Смена каталога означает
 * пересборку индекса и перезапуск наблюдателя, то есть отдельную операцию с
 * прогрессом, а поле ввода рядом с цифрами «412 файлов · 570 МБ» обещало бы,
 * что достаточно вписать другой путь. Пока путь меняется в `config.json`, и
 * это сказано здесь, а не подразумевается.
 *
 * Число файлов и размер приезжают из main (`SourceStatus`): считать их в окне
 * значило бы обойти 570 МБ ради экрана настроек.
 */
const BADGE: Record<SourceStatus['provider'], string> = { claude: 'CL', codex: 'CX' }

export interface SettingsSourcesProps {
  sources: SourceStatus[]
  /** Что загрузчик не понял в файле настроек. Пусто — принято всё. */
  problems: string[]
}

export function SettingsSources({ sources, problems }: SettingsSourcesProps) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionTitle title={t('settings.logPaths')} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sources.map((source) => (
            <div
              key={source.provider}
              data-source-row={source.provider}
              style={{
                display: 'grid',
                gridTemplateColumns: '70px 1fr auto',
                gap: 12,
                alignItems: 'center',
                padding: '9px 12px',
                background: 'var(--s1)',
                border: '1px solid var(--line)',
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--bg)',
                  background: `var(--${source.provider})`,
                  borderRadius: 3,
                  padding: '2px 5px',
                  justifySelf: 'start',
                }}
              >
                {BADGE[source.provider]}
              </span>
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 11.5,
                  color: 'var(--tx2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {source.path}
              </span>
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 10.5,
                  color: source.readable ? 'var(--ok)' : 'var(--alarm)',
                  whiteSpace: 'nowrap',
                }}
              >
                {source.readable
                  ? t('settings.sourceOk', {
                      files: t('settings.files', { count: source.files }),
                      size: t('settings.megabytes', { value: megabytes(source.bytes) }),
                    })
                  : t('settings.sourceMissing')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {problems.length === 0 ? null : (
        <div data-config-problems="" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SectionTitle title={t('settings.problems')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {problems.map((problem) => (
              <div
                key={problem}
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 10.5,
                  color: 'var(--warn)',
                  padding: '9px 12px',
                  background: 'var(--s1)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                }}
              >
                {problem}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Мегабайты одной цифрой после запятой.
 *
 * Форматирование, а не арифметика над расходом: это байты файлов на диске, а не
 * токены. Общий `formatTokens` сюда не годится — в 2.8 его уже применяли к
 * мегабайтам, и гигабайт логов превращался в «1.2k МБ».
 */
function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
