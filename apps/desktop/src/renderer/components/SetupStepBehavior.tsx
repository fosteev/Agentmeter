import type { Config } from '@agentmeter/core'
import type { SetupScan, StartupStatus } from '@agentmeter/ipc'
import { setupProgress, type SetupDraft } from '../setup.ts'
import { t } from '../format.ts'
import { megabytes } from './SetupProviderCard.tsx'
import { SetupHeading } from './SetupFrame.tsx'
import { remaining } from './PopupIndexing.tsx'
import { Switch } from './Switch.tsx'

/**
 * Шаг 3 мастера — «Поведение и приватность», строки 2008–2040 макета.
 *
 * Оставлено то, у чего есть пара в «Настройках»: автозапуск («Приложение»),
 * скрытие промптов («Приватность»), тема («Внешний вид»). Сняты: «показывать
 * проценты в трее» (переключателя нет, текст трея считается всегда) и «собрать
 * историю за прошлые дни» (проход всегда читает всё).
 *
 * Подзаголовок макета «сеть используется единственный раз» — неправда с 6.3:
 * вызовов три. Вместо него три тумблера — по вызову на каждый, лимиты выключены
 * по умолчанию, — и каждый пишется тем же полем, что в «Лимитах» и «Приложении».
 *
 * Карточка «Что произойдёт дальше» — показ: объём логов и **одна** живая строка
 * про проход, который к этому шагу уже идёт. Время — готовая оценка `etaMs` со
 * знаком `≈`; пока её нет, слова «оцениваем…», а не «0 с».
 */
export interface SetupStepBehaviorProps {
  draft: SetupDraft
  onDraft: (patch: Partial<SetupDraft>) => void
  startup: StartupStatus
  /** Проверка обновлений работает только в установленном приложении. */
  updatesSupported: boolean
  scan: SetupScan | null
  /** Снимок трея уже приезжал: до этого ход прохода неизвестен, а не «закончен». */
  snapshotKnown: boolean
  indexing: Parameters<typeof setupProgress>[2]
}

const MONO = "'IBM Plex Mono', monospace"
/** Ключи, а не подписи: `t()` на верхнем уровне модуля застыл бы на языке запуска. */
const THEMES: ReadonlyArray<{ value: Config['ui']['theme']; key: 'settings.themeDark' | 'settings.themeLight' | 'settings.themeSystem' }> = [
  { value: 'dark', key: 'settings.themeDark' },
  { value: 'light', key: 'settings.themeLight' },
  { value: 'system', key: 'settings.themeSystem' },
]

export function SetupStepBehavior({
  draft,
  onDraft,
  startup,
  updatesSupported,
  scan,
  snapshotKnown,
  indexing,
}: SetupStepBehaviorProps) {
  const files = scan?.providers.reduce((sum, provider) => sum + provider.files, 0) ?? 0
  const bytes = scan?.providers.reduce((sum, provider) => sum + provider.bytes, 0) ?? 0
  const progress = setupProgress(scan, snapshotKnown, indexing)

  return (
    <div
      data-setup-step="3"
      style={{
        flex: 1,
        // Без этого тело шага растёт за раму, и рама обрезает его молча: смоук
        // меряет `scrollHeight` тела, а не окна.
        minHeight: 0,
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <SetupHeading title={t('setup.behaviorTitle')} lede={t('setup.behaviorLede')} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <Switch
          name="launchAtLogin"
          label={t('settings.launchAtLogin')}
          note={startup.reason}
          checked={draft.startup}
          disabled={!startup.available}
          onChange={(value) => onDraft({ startup: value })}
        />
        <Switch
          name="hidePrompts"
          label={t('settings.hidePrompts')}
          note={t('settings.hidePromptsNote')}
          checked={draft.hidePrompts}
          onChange={(value) => onDraft({ hidePrompts: value })}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5 }}>{t('settings.theme')}</span>
          <div style={{ display: 'flex', gap: 4, fontFamily: MONO, fontSize: 11 }}>
            {THEMES.map((theme) => (
              <button
                key={theme.value}
                type="button"
                data-theme-choice={theme.value}
                aria-pressed={draft.theme === theme.value}
                onClick={() => onDraft({ theme: theme.value })}
                style={{
                  padding: '4px 9px',
                  border: 0,
                  borderRadius: 5,
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  cursor: 'pointer',
                  background: draft.theme === theme.value ? 'var(--s2)' : 'transparent',
                  color: draft.theme === theme.value ? 'var(--tx)' : 'var(--tx2)',
                }}
              >
                {t(theme.key)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <Label text={t('setup.networkSection')} />
        <Switch
          name="oauth"
          label={t('setup.askAnthropic')}
          note={t('setup.askNote')}
          checked={draft.claudeApi}
          onChange={(value) => onDraft({ claudeApi: value })}
        />
        <Switch
          name="codex-oauth"
          label={t('setup.askOpenai')}
          note={t('setup.askNote')}
          checked={draft.codexApi}
          onChange={(value) => onDraft({ codexApi: value })}
        />
        <Switch
          name="updatesAuto"
          label={t('settings.updateAuto')}
          note={t('settings.updateAutoNote')}
          checked={draft.updatesAuto}
          disabled={!updatesSupported}
          onChange={(value) => onDraft({ updatesAuto: value })}
        />
      </div>

      <div
        data-setup-next=""
        style={{
          border: '1px solid var(--line)',
          borderRadius: 8,
          background: 'var(--s1)',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <Label text={t('setup.nextTitle')} />
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: 'var(--tx2)',
            lineHeight: 1.8,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <div data-setup-logs="">
            {files === 0
              ? t('setup.nextNoLogs')
              : t('setup.nextLogs', {
                  size: t('settings.megabytes', { value: megabytes(bytes) }),
                  files: t('settings.files', { count: files }),
                })}
          </div>
          {progress.kind === 'nothing' ? null : (
            <div data-setup-progress-line={progress.kind}>
              {progress.kind === 'reading'
                ? t('setup.nextReading', {
                    percent: progress.percent,
                    eta: progress.etaMs === null ? t('setup.estimating') : remaining(progress.etaMs),
                  })
                : progress.kind === 'done'
                  ? t('setup.nextDone')
                  : t('setup.estimating')}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 'auto', fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.55, textWrap: 'pretty' }}>
        {t('setup.nextFoot')}
      </div>
    </div>
  )
}

function Label({ text }: { text: string }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: '.14em',
        textTransform: 'uppercase',
        color: 'var(--tx3)',
      }}
    >
      {text}
    </div>
  )
}
