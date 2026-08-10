import type { Config } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

/**
 * «Пороги уведомлений» — строки 1169–1183 макета.
 *
 * Ползунок нарисован своими прямоугольниками, а тянет его невидимый
 * `input[type=range]` поверх: системный ползунок не красится инлайновыми
 * стилями, а рисовать свой перетаскиванием мышью значит написать заново то,
 * что уже есть в браузере, — вместе с клавиатурой, шагом и доступностью.
 *
 * Порог тревоги ниже порога предупреждения загрузчик отвергает целиком (см.
 * `config/load.ts`): предупреждать после того, как ударили тревогу, нечем
 * объяснить. Здесь это видно сразу — ползунки друг друга не пропускают.
 */
export interface SettingsAlertsProps {
  config: Config
  onChange: (patch: DeepPartial<Config>) => void
}

export function SettingsAlerts({ config, onChange }: SettingsAlertsProps) {
  const { warnAtPercent, dangerAtPercent } = config.alerts

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle title={t('settings.thresholds')} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Threshold
          name="warn"
          label={t('settings.warnAt')}
          value={warnAtPercent}
          color="var(--warn)"
          max={dangerAtPercent}
          onChange={(value) => onChange({ alerts: { warnAtPercent: value } })}
        />
        <Threshold
          name="danger"
          label={t('settings.dangerAt')}
          value={dangerAtPercent}
          color="var(--alarm)"
          min={warnAtPercent}
          onChange={(value) => onChange({ alerts: { dangerAtPercent: value } })}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12.5 }}>
          <input
            type="checkbox"
            data-setting="notifyOnIdle"
            checked={config.alerts.notifyOnIdle}
            onChange={(event) =>
              onChange({ alerts: { notifyOnIdle: event.currentTarget.checked } })
            }
          />
          {t('settings.notifyOnIdle')}
        </label>
      </div>
    </div>
  )
}

function Threshold({
  name,
  label,
  value,
  color,
  min = 0,
  max = 100,
  onChange,
}: {
  name: string
  label: string
  value: number
  color: string
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ fontSize: 12.5, width: 150 }}>{label}</span>
      <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--s2)', position: 'relative' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 2 }} />
        <div
          data-thumb={name}
          style={{
            position: 'absolute',
            left: `${value}%`,
            top: -4,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: 'var(--tx)',
            marginLeft: -6,
          }}
        />
        <input
          type="range"
          data-setting={name}
          aria-label={label}
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          style={{
            position: 'absolute',
            left: 0,
            top: -6,
            width: '100%',
            height: 16,
            margin: 0,
            opacity: 0,
            cursor: 'pointer',
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          width: 44,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}%
      </span>
    </div>
  )
}
