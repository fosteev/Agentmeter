import type { UsageHookStatus } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'
import { Switch } from './Switch.tsx'

/**
 * «Настоящие лимиты Claude» — блок раздела «Лимиты» (1.9).
 *
 * Стоит рядом с потолками плана не случайно: подпись под ними — «оценка по
 * локальным логам», и здесь ровно то, что снимает это слово. Процента лимита
 * Claude в логи не пишет вовсе, но отдаёт его своей строке состояния, и хук
 * записывает полученное на диск.
 *
 * Тумблер правит **чужой** файл настроек (`~/.claude/settings.json`), поэтому
 * путь к нему написан рядом с ним, а не спрятан: человек должен видеть, куда
 * приложение собирается писать, до того как нажмёт.
 *
 * Ниже — счётчик накопленного, и он честный: пока снимков мало, вместо веса
 * стоит «данных мало», а не правдоподобное число. Это тот самый экран, на
 * котором соблазн показать красивый коэффициент сильнее всего.
 */
export interface SettingsUsageProps {
  usage: UsageHookStatus
  onToggle: (enabled: boolean) => void
  /**
   * Пересчитать вес по журналу прямо сейчас.
   *
   * Кнопка **не** зовёт хук: строку состояния рисует Claude Code, проценты
   * приезжают в его ответе API, и снаружи этого не вызвать. Она пересчитывает
   * уже собранное — потому и называется «Пересчитать», а не «Обновить».
   */
  onRefresh: () => void
}

export function SettingsUsage({ usage, onToggle, onRefresh }: SettingsUsageProps) {
  const collected = t('settings.usageCollected', {
    points: t('settings.usagePoints', { count: usage.points }),
    windows: t('settings.usageWindows', { count: usage.windows }),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle title={t('settings.usage')} />
      <div style={CARD}>
        <Switch
          name="statusline"
          label={usage.installed ? t('settings.usageOn') : t('settings.usageOff')}
          note={t('settings.usageNote')}
          checked={usage.installed}
          onChange={onToggle}
        />

        <span style={NOTE} data-statusline-state="">
          {usage.installed
            ? t('settings.usageInstalled', { path: usage.settingsPath })
            : t('settings.usageAbsent')}
        </span>

        {usage.chained === undefined ? null : (
          <span style={NOTE}>{t('settings.usageChained', { command: usage.chained })}</span>
        )}

        {usage.problem === undefined ? null : (
          <span style={{ ...NOTE, color: 'var(--alarm)' }}>{usage.problem}</span>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={NOTE} data-statusline-weight="">
            {`${collected} · `}
            {usage.weight === null
              ? t('settings.usageFew')
              : t('settings.usageWeight', { weight: usage.weight.toFixed(2) })}
          </span>
          <button type="button" data-usage-action="refresh" onClick={onRefresh} style={CHIP}>
            {t('settings.usageRefresh')}
          </button>
        </div>
      </div>
    </div>
  )
}

const CARD = {
  padding: '11px 12px',
  background: 'var(--s1)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const

const NOTE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: 'var(--tx3)',
} as const

/** Тот же вид кнопки, что у выбора плана в соседней карточке того же блока. */
const CHIP = {
  padding: '4px 9px',
  border: 0,
  borderRadius: 5,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
  cursor: 'pointer',
  background: 'var(--s2)',
  color: 'var(--tx)',
  flex: 'none',
} as const
