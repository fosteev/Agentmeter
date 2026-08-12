import type { Config } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

/**
 * «Потолки лимитов по плану» — строки 1197–1218 макета.
 *
 * План выбирается кнопками, а потолки под ним — числа из таблицы планов, а не
 * из логов: у Claude их на диске нет вовсе (см. `config/types.ts`). Отсюда и
 * подпись «оценка по локальным логам» под левой карточкой против «точные
 * значения приходят от сервера» под правой — это не украшение, а разное
 * происхождение цифр, и путать их нельзя.
 *
 * У Codex настраивать нечего: лимиты приезжают в логе точными. Карточка
 * оставлена, потому что вопрос «а мой план тут учтён?» возникает у обоих
 * провайдеров, и пустое место ответом не является.
 */
export interface SettingsLimitsProps {
  config: Config
  onChange: (patch: DeepPartial<Config>) => void
}

/**
 * Планы Claude и их потолки в токенах пятичасового и недельного окна.
 *
 * Числа — не измерение, а объявленные тарифы, поэтому лежат в интерфейсе, а не
 * в ядре: ядро считает то, что в логах. Пока лимит не откалиброван (1.9),
 * проценты по ним всё равно помечаются оценкой.
 */
const CLAUDE_PLANS: ReadonlyArray<{ plan: string; fiveHourCap: number; weeklyCap: number }> = [
  { plan: 'Max 20×', fiveHourCap: 220_000, weeklyCap: 4_400_000 },
  { plan: 'Max 5×', fiveHourCap: 88_000, weeklyCap: 1_760_000 },
  { plan: 'Pro', fiveHourCap: 44_000, weeklyCap: 880_000 },
]

export function SettingsLimits({ config, onChange }: SettingsLimitsProps) {
  const current = config.limits.claude.plan

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle title={t('settings.caps')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={CARD}>
          <span style={{ fontSize: 12 }}>{t('settings.claudePlan')}</span>
          <div style={CHIPS}>
            {CLAUDE_PLANS.map((plan) => (
              <button
                key={plan.plan}
                type="button"
                data-plan={plan.plan}
                aria-pressed={current === plan.plan}
                onClick={() =>
                  onChange({
                    limits: {
                      claude: {
                        plan: plan.plan,
                        fiveHourCap: plan.fiveHourCap,
                        weeklyCap: plan.weeklyCap,
                      },
                    },
                  })
                }
                style={chip(current === plan.plan)}
              >
                {plan.plan}
              </button>
            ))}
          </div>
          <span style={NOTE}>
            {config.limits.claude.fiveHourCap === null
              ? t('settings.planNotSet')
              : `${formatTokens(config.limits.claude.fiveHourCap)} · ${t('settings.capsEstimate')}`}
          </span>
        </div>

        <div style={CARD}>
          <span style={{ fontSize: 12 }}>{t('settings.codexPlan')}</span>
          <div style={CHIPS} />
          <span style={{ ...NOTE, color: 'var(--ok)' }}>{t('settings.capsExact')}</span>
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

const CHIPS = {
  display: 'flex',
  gap: 4,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
} as const

const NOTE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: 'var(--tx3)',
} as const

function chip(selected: boolean) {
  return {
    padding: '4px 9px',
    border: 0,
    borderRadius: 5,
    font: 'inherit',
    cursor: 'pointer',
    background: selected ? 'var(--s2)' : 'transparent',
    color: selected ? 'var(--tx)' : 'var(--tx2)',
  } as const
}
