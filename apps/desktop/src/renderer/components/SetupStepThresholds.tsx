import type { SetupDraft } from '../setup.ts'
import { t } from '../format.ts'
import { SetupHeading } from './SetupFrame.tsx'
import { Switch } from './Switch.tsx'

/**
 * Шаг 2 мастера — «Пороги и уведомления», строки 1926–1977 макета.
 *
 * Из макета остались пороги и два уведомления. Сняты: «Потолки по плану» с
 * чипами Max/Pro/Plus (потолки измеряет калибровка, 7.4), «Дорогая сессия» и
 * «Переплата за паузу» (у них нет места в «Настройках»). Подзаголовок про план
 * переписан: процент берётся у провайдера или из логов.
 *
 * Ползунок нарисован своими прямоугольниками, а тянет его невидимый
 * `input[type=range]` поверх — как в «Настройках» (`SettingsAlerts`): тот же
 * `data-setting`, те же границы, и порог тревоги ниже порога предупреждения
 * невозможен и здесь. Дефолт 75/90 берётся из конфига, а не 92 из макета.
 */
export interface SetupStepThresholdsProps {
  draft: SetupDraft
  onDraft: (patch: Partial<SetupDraft>) => void
}

const MONO = "'IBM Plex Mono', monospace"

export function SetupStepThresholds({ draft, onDraft }: SetupStepThresholdsProps) {
  return (
    <div
      data-setup-step="2"
      style={{
        flex: 1,
        // Без этого тело шага растёт за раму, и рама обрезает его молча: смоук
        // меряет `scrollHeight` тела, а не окна.
        minHeight: 0,
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <SetupHeading title={t('setup.thresholdsTitle')} lede={t('setup.thresholdsLede')} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Label text={t('setup.warnSection')} />
        <Threshold
          name="warn"
          label={t('settings.warnAt')}
          value={draft.warnAtPercent}
          color="var(--warn)"
          max={draft.dangerAtPercent}
          onChange={(value) => onDraft({ warnAtPercent: value })}
        />
        <Threshold
          name="danger"
          label={t('settings.dangerAt')}
          value={draft.dangerAtPercent}
          color="var(--alarm)"
          min={draft.warnAtPercent}
          onChange={(value) => onDraft({ dangerAtPercent: value })}
        />
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          borderTop: '1px solid var(--line)',
          paddingTop: 16,
        }}
      >
        <Label text={t('setup.alsoSection')} />
        <Switch
          name="notifyOnWaiting"
          label={t('settings.notifyOnWaiting')}
          checked={draft.notifyOnWaiting}
          onChange={(value) => onDraft({ notifyOnWaiting: value })}
        />
        <Switch
          name="notifyOnDone"
          label={t('settings.notifyOnDone')}
          checked={draft.notifyOnDone}
          onChange={(value) => onDraft({ notifyOnDone: value })}
        />
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
          fontFamily: MONO,
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
