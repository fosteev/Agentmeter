import type { SpendSplit } from '@agentmeter/ipc'
import { SectionTitle } from './SectionTitle.tsx'
import { formatTokens, t } from '../format.ts'
import { hatch } from '../paint.ts'

/**
 * «Куда ушло сегодня» — постоянное против разового (4.1, строки 767–778 макета).
 *
 * Штриховка здесь означает «постоянный», а не «оценка», и это не новая
 * договорённость: она задана блоком `BreakdownRow` в разделе 0 (строки
 * 191–202) и уже реализована там же. Оценку по-прежнему называет знак `≈`
 * перед числом — иначе две вещи, у которых один вид, стали бы неразличимы.
 *
 * Доли приезжают посчитанными: их видно числом рядом с текстом. Ширина полос —
 * те же доли, а не второй счёт от токенов: разойдись подпись и полоса, и на
 * экране окажутся два ответа на один вопрос.
 */
export interface SpendBarProps {
  split: SpendSplit
}

const LABEL: Record<SpendSplit['slices'][number]['kind'], 'split.recurring' | 'split.marginal'> = {
  recurring: 'split.recurring',
  marginal: 'split.marginal',
}

export function SpendBar({ split }: SpendBarProps) {
  return (
    <div
      data-spend-split
      style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <SectionTitle title={t('split.title')} />
      <div style={{ display: 'flex', height: 10, borderRadius: 3, overflow: 'hidden' }}>
        {split.slices.map((slice) => (
          <div
            key={slice.kind}
            data-spend-fill={slice.kind}
            style={{
              width: `${slice.share * 100}%`,
              background: slice.kind === 'recurring' ? hatch('var(--warn)') : 'var(--codex)',
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          color: 'var(--tx2)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {split.slices.map((slice) => (
          <div
            key={slice.kind}
            data-spend-row={slice.kind}
            style={{ display: 'flex', justifyContent: 'space-between' }}
            title={slice.tokens.caveat}
          >
            <span>{t(LABEL[slice.kind])}</span>
            <span>
              {t('split.value', {
                tokens: `${slice.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(slice.tokens.value)}`,
                percent: Math.round(slice.share * 100),
              })}
            </span>
          </div>
        ))}
      </div>
      {split.note === undefined ? null : (
        <div
          data-spend-note
          style={{
            fontSize: 11.5,
            color: 'var(--tx2)',
            lineHeight: 1.5,
            borderTop: '1px solid var(--line)',
            paddingTop: 10,
          }}
        >
          {split.note}
        </div>
      )}
    </div>
  )
}
