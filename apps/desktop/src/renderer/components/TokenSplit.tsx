import type { TaskCard as TaskCardData, TokenSlice } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

/**
 * Ключ вместо слова: имена видов токенов — термины провайдера (`cache read`,
 * `cache write`), и переводить их врозь нельзя (глоссарий 3.8). Длина каждого
 * проверяется потолком: подпись стоит в колонке рядом с числом.
 */
const TOKEN_STYLE = {
  input: { key: 'tokens.input', color: 'var(--claude)' },
  cacheWrite: {
    key: 'tokens.cacheWrite',
    color: 'color-mix(in oklch, var(--claude) 55%, transparent)',
  },
  cacheRead: { key: 'tokens.cacheRead', color: 'var(--codex)' },
  output: { key: 'tokens.output', color: 'var(--ok)' },
} as const satisfies Record<TokenSlice['kind'], { key: string; color: string }>

/**
 * Раскладка по видам токенов. Рамку колонки и её поля рисует `TaskCard`: числа
 * этих полей приходят из блока сетки макета (строки 906 и 923), а не из блока
 * самой раскладки, и держать их надо там, где числовая приёмка их и сверяет.
 */
export function TokenSplit({
  tokens,
  note,
}: {
  tokens: TokenSlice[]
  note?: TaskCardData['note']
}) {
  return (
    <>
      <SectionTitle title={t('card.tokenSplit')} />
      <div style={{ display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden' }}>
        {tokens.map((slice, index) => (
          <div
            key={`${slice.kind}:${index}`}
            data-token-slice={slice.kind}
            style={{ width: `${slice.share * 100}%`, background: TOKEN_STYLE[slice.kind].color }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11.5,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {tokens.map((slice, index) => {
          const tokenStyle = TOKEN_STYLE[slice.kind]
          return (
            <div
              key={`${slice.kind}:${index}`}
              data-token-legend={slice.kind}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: tokenStyle.color,
                  flex: 'none',
                }}
              />
              <span style={{ flex: 1, color: 'var(--tx2)' }}>{t(tokenStyle.key)}</span>
              <span>{formatTokens(slice.tokens.value)}</span>
              <span style={{ width: 44, textAlign: 'right', color: 'var(--tx3)' }}>
                {Math.round(slice.share * 100)}%
              </span>
            </div>
          )
        })}
      </div>
      {note === undefined ? null : (
        <div
          data-token-note=""
          style={{
            borderTop: '1px solid var(--line)',
            paddingTop: 12,
            fontSize: 11.5,
            color: 'var(--tx2)',
            lineHeight: 1.5,
          }}
        >
          {note.text}{' '}
          {note.advice === undefined ? null : (
            <span style={{ color: 'var(--tx3)' }}>{note.advice}</span>
          )}
        </div>
      )}
    </>
  )
}
