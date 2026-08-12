import type { Config } from '@agentmeter/core'
import { formatTokens, t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

/**
 * «Потолки лимитов» — строки 1197–1218 макета.
 *
 * В макете здесь чипы плана: Max 20× / Max 5× / Pro у Claude, Pro / Plus у
 * Codex. Кнопок больше нет, и это не упрощение вёрстки, а находка 7.4.
 *
 * Потолок Claude выражен во **взвешенных** токенах — `I + W + O + w·R`, — и в
 * этих единицах объявленных тарифов не существует: калибровка 1.9 решает
 * систему `p/100 · cap = I + W + O + w · R` и получает потолок вместе с весом.
 * Чипы же писали в то же поле числа из таблицы тарифов (220 000 у «Max 20×»),
 * которых никто не мерил, — и, что хуже, выбранный план **запрещал** записать
 * туда измеренное. То есть единственный путь, на котором кнопки влияли на
 * числа, был «показать процент от выдуманного знаменателя».
 *
 * Поэтому карточка показывает измеренное и молчит, пока мерить не из чего:
 * «не измерено» — честный ответ, а правдоподобное число на этом месте — нет.
 * Как именно оно меряется, написано в соседнем блоке того же раздела
 * (`SettingsUsage`) — там же и кнопки, которые его добывают.
 *
 * У Codex потолка нет вовсе и не будет: провайдер сообщает процент готовым.
 * Вторая строка карточки — про его возраст, а не про число: в логе процент
 * написан в момент запроса (6.4).
 */
export interface SettingsLimitsProps {
  config: Config
}

export function SettingsLimits({ config }: SettingsLimitsProps) {
  const { fiveHourCap, weeklyCap, cacheReadWeight } = config.limits.claude
  const rows: ReadonlyArray<{ label: string; value: string }> = [
    { label: t('limit.fiveHour'), value: cap(fiveHourCap) },
    { label: t('limit.weekly'), value: cap(weeklyCap) },
    {
      label: t('settings.capsWeight'),
      value: cacheReadWeight === null ? t('settings.capsNotMeasured') : cacheReadWeight.toFixed(2),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle title={t('settings.caps')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={CARD}>
          <span style={{ fontSize: 12 }}>{t('settings.claudeCaps')}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rows.map((row) => (
              <div
                key={row.label}
                data-cap={row.label}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 8, ...MONO }}
              >
                <span>{row.label}</span>
                <span style={{ color: 'var(--tx2)' }}>{row.value}</span>
              </div>
            ))}
          </div>
          <span style={NOTE}>{t('settings.capsMeasuredNote')}</span>
        </div>

        <div style={CARD}>
          <span style={{ fontSize: 12 }}>{t('settings.codexCaps')}</span>
          <span style={{ ...NOTE, color: 'var(--ok)' }}>{t('settings.capsCodexNote')}</span>
          <span style={NOTE}>{t('settings.capsCodexStale')}</span>
        </div>
      </div>
    </div>
  )
}

/** Потолок словами: измеренное число или прямой отказ, но не ноль и не прочерк. */
function cap(value: number | null): string {
  return value === null ? t('settings.capsNotMeasured') : formatTokens(value)
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

const MONO = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
} as const

const NOTE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: 'var(--tx3)',
} as const
