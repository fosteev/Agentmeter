import type { LimitReportRow, Provider } from '@agentmeter/core'
import { t } from '../format.ts'

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'CL',
  codex: 'CX',
}

function levelColor(percent: number): string {
  if (percent > 85) return 'var(--alarm)'
  if (percent >= 60) return 'var(--warn)'
  return 'var(--ok)'
}

/**
 * Штриховка оценки берёт цвет своего уровня, а не тот, что нарисован в макете.
 *
 * В строке 579 заштриховано окно на 68%, то есть жёлтое, и вшить сюда `--warn`
 * значило бы показать оценку на 95% спокойным цветом. Штриховка помечает
 * точность, шкала — тревогу; это две разные оси, и путать их нельзя.
 */
function hatch(color: string): string {
  return `repeating-linear-gradient(115deg, ${color} 0 3px, color-mix(in oklch, ${color} 32%, transparent) 3px 7px)`
}

export interface WindowLimitProps {
  limit: LimitReportRow
}

export function WindowLimit({ limit }: WindowLimitProps) {
  const percent = limit.usedPercent
  const known = percent !== null
  const color = known ? levelColor(percent) : 'var(--tx3)'

  return (
    <div
      title={known ? undefined : (limit.unavailableReason ?? t('limit.unknownPercent'))}
      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
    >
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          color: known && limit.exact ? 'var(--tx2)' : color,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {PROVIDER_LABEL[limit.provider]}{' '}
        {known ? `${limit.exact ? '' : '≈'}${Math.round(percent)}%` : '—'}
      </span>
      {known ? (
        <div
          style={{
            width: 56,
            height: 5,
            borderRadius: 3,
            background: 'var(--s2)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              background: limit.exact ? color : hatch(color),
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
