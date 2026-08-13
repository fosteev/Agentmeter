import type { Config, PopupWindows } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'
import { Switch } from './Switch.tsx'

/**
 * «Что показывать в попапе» — блок раздела «Лимиты» (7.5).
 *
 * Стоит на месте прежних «потолков плана», и это не перестановка мебели. Та
 * карточка показывала три строки «не измерено» и предлагала выбрать план,
 * которым потолок не выбирается (находка 7.4); здесь — единственное решение,
 * которое человеку про лимиты действительно принимать: какие окна ему нужны
 * перед глазами. Попап отвечает на вопрос «можно ли работать дальше», и лишняя
 * строка в нём стоит места, отнятого у ответа.
 *
 * Список окон **постоянный, а не по снимку**. Месячное окно Codex появляется в
 * снимке в тот день, когда провайдер о нём заговорил, — если бы галочка
 * заводилась вместе с окном, первое такое окно приехало бы в попап без спроса,
 * и настройка означала бы «убрать то, что уже показали».
 *
 * Снятая галочка убирает окно и из значка в трее, и из уведомлений — фильтр
 * стоит в `main/snapshot.ts`, до всех троих. Про это написано прямо в блоке:
 * настройка, которая делает больше, чем обещает названием, — такое же враньё,
 * как число от выдуманного знаменателя.
 */
export interface SettingsPopupLimitsProps {
  config: Config
  onChange: (patch: DeepPartial<Config>) => void
}

/** Провайдер, его окна и подписи. Ключи, а не тексты: `t()` на верхнем уровне
 *  застыл бы на языке загрузки. */
const GROUPS = [
  {
    provider: 'claude',
    label: 'Claude',
    kinds: [
      { kind: 'fiveHour', key: 'limit.fiveHour' },
      { kind: 'weekly', key: 'limit.weekly' },
    ],
  },
  {
    provider: 'codex',
    label: 'Codex',
    kinds: [
      { kind: 'fiveHour', key: 'limit.fiveHour' },
      { kind: 'weekly', key: 'limit.weekly' },
      { kind: 'monthly', key: 'limit.monthly' },
      { kind: 'other', key: 'limit.other' },
    ],
  },
] as const

export function SettingsPopupLimits({ config, onChange }: SettingsPopupLimitsProps) {
  const popup = config.limits.popup

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle title={t('settings.popupLimits')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {GROUPS.map((group) => (
          <div key={group.provider} style={CARD}>
            <span style={{ fontSize: 12 }}>{group.label}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {group.kinds.map((window) => {
                const shown: Record<string, boolean> = popup[group.provider]
                return (
                  <Switch
                    key={window.kind}
                    name={`popup-${group.provider}-${window.kind}`}
                    label={t(window.key as 'limit.fiveHour')}
                    checked={shown[window.kind] !== false}
                    onChange={(value) => onChange(patch(group.provider, window.kind, value))}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <span style={NOTE}>{t('settings.popupLimitsNote')}</span>
    </div>
  )
}

/** Правка одной галочки — точечная: соседние окна конфигу не пересылаются. */
function patch(provider: keyof PopupWindows, kind: string, value: boolean): DeepPartial<Config> {
  return { limits: { popup: { [provider]: { [kind]: value } } } } as DeepPartial<Config>
}

const CARD = {
  padding: '11px 12px',
  background: 'var(--s1)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
} as const

const NOTE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: 'var(--tx3)',
} as const
