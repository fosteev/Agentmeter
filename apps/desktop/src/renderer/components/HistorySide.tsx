import type { HistoryDaySummary } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { mono } from './HistoryTab.tsx'

/**
 * Правая колонка «Истории» — сводка выбранного дня, строки 1436–1489 макета.
 *
 * Все числа и доли приезжают готовыми; здесь считаются только ширины полосок
 * внутри своих диаграмм. Полоса провайдеров при этом берёт **приехавшую** долю,
 * а не считает её от суммы: доля видна числом рядом, и второй её экземпляр
 * разошёлся бы с первым на округлении.
 */
export interface HistorySideProps {
  summary?: HistoryDaySummary
  firstDay: number
  daysWithSpend: number
  /** Открыть вкладку «Развёртка» на этом дне. Кнопка есть только у сводки. */
  onOpenBreakdown: (at: number) => void
}

const TOKEN_GRID = '1fr 62px 44px'

export function HistorySide({ summary, firstDay, daysWithSpend, onOpenBreakdown }: HistorySideProps) {
  return (
    <div
      data-history-side
      style={{ background: 'var(--s1)', display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{
          padding: '18px 18px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>
            {summary === undefined ? t('history.emptyRange') : dayTitle(summary.at)}
          </span>
          {summary === undefined ? null : (
            <span style={{ ...mono(16), fontWeight: 600 }}>
              {summary.total.confidence === 'exact' ? '' : '≈'}
              {formatTokens(summary.total.value)}
            </span>
          )}
        </div>
        <span style={{ ...mono(11), color: 'var(--tx2)' }}>
          {summary === undefined
            ? t('history.since', {
                date: new Date(firstDay).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'long',
                }),
                days: t('history.daysWithSpend', { count: daysWithSpend }),
              })
            : t('history.counts', {
                sessions: t('today.sessions', { count: summary.sessions }),
                tasks: t('today.requests', { count: summary.tasks }),
                requests: t('today.requests', { count: summary.requests }),
              })}
        </span>
        {summary === undefined ? null : (
          <button
            type="button"
            data-history-breakdown={summary.at}
            onClick={() => onOpenBreakdown(summary.at)}
            style={{
              alignSelf: 'flex-start',
              marginTop: 4,
              // Отступы — из чисел своего блока макета (сторож tokens.test.ts).
              padding: '4px 10px',
              fontSize: 11.5,
              borderRadius: 4,
              border: '1px solid var(--line)',
              background: 'transparent',
              color: 'var(--tx2)',
              cursor: 'pointer',
            }}
          >
            {t('history.openBreakdown')} →
          </button>
        )}
      </div>

      {summary === undefined ? null : (
        <>
          <section
            style={{
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 11,
              borderBottom: '1px solid var(--line)',
            }}
          >
            <Caption>{t('history.tokenTypes')}</Caption>
            {summary.tokens.map((slice) => (
              <div
                key={slice.kind}
                data-history-token={slice.kind}
                style={{ display: 'grid', gridTemplateColumns: TOKEN_GRID, gap: 8, alignItems: 'center' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12 }}>{t(`tokens.${slice.kind}`)}</span>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--s2)', overflow: 'hidden' }}>
                    <div style={{ width: `${slice.share * 100}%`, height: '100%', background: 'var(--tx3)' }} />
                  </div>
                </div>
                <span style={{ ...mono(11.5), textAlign: 'right' }}>
                  {slice.tokens.confidence === 'exact' ? '' : '≈'}
                  {formatTokens(slice.tokens.value)}
                </span>
                <span style={{ ...mono(11), textAlign: 'right', color: 'var(--tx3)' }}>
                  {(slice.share * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </section>

          <section
            style={{
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
              borderBottom: '1px solid var(--line)',
            }}
          >
            <Caption>{t('history.providers')}</Caption>
            <div style={{ display: 'flex', height: 8, borderRadius: 3, overflow: 'hidden' }}>
              {summary.providers.map((row) => (
                <div
                  key={row.provider}
                  style={{ width: `${row.share * 100}%`, background: `var(--${row.provider})` }}
                />
              ))}
            </div>
            {summary.providers.map((row) => (
              <div
                key={row.provider}
                data-history-provider={row.provider}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 10,
                  ...mono(11.5),
                }}
              >
                <span style={{ color: `var(--${row.provider})` }}>{PROVIDER[row.provider]}</span>
                <span>
                  {row.tokens.confidence === 'exact' ? '' : '≈'}
                  {formatTokens(row.tokens.value)}{' '}
                  <span style={{ color: 'var(--tx3)' }}>{(row.share * 100).toFixed(1)}%</span>
                </span>
              </div>
            ))}
          </section>

          {summary.split === undefined ? null : (
            <section
              style={{
                padding: '16px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
                borderBottom: '1px solid var(--line)',
              }}
            >
              <Caption>{t('history.splitTitle')}</Caption>
              <div style={{ display: 'flex', height: 8, borderRadius: 3, overflow: 'hidden' }}>
                {summary.split.slices.map((slice) => (
                  <div
                    key={slice.kind}
                    style={{
                      width: `${slice.share * 100}%`,
                      background: slice.kind === 'recurring' ? 'var(--warn)' : 'var(--codex)',
                    }}
                  />
                ))}
              </div>
              {summary.split.slices.map((slice) => (
                <div
                  key={slice.kind}
                  data-history-split={slice.kind}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 10,
                    ...mono(11.5),
                  }}
                >
                  <span>{t(`split.${slice.kind}`)}</span>
                  <span>
                    {slice.tokens.confidence === 'exact' ? '' : '≈'}
                    {formatTokens(slice.tokens.value)}{' '}
                    <span style={{ color: 'var(--tx3)' }}>{Math.round(slice.share * 100)}%</span>
                  </span>
                </div>
              ))}
              {summary.splitMedian === undefined ? null : (
                <div data-history-median style={{ ...mono(10.5), color: 'var(--tx3)' }}>
                  {t('history.splitMedian', {
                    days: t('history.daysWithSpend', { count: daysWithSpend }),
                    percent: (summary.splitMedian * 100).toFixed(1),
                  })}
                </div>
              )}
            </section>
          )}

          <section style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <Caption>{t('history.projects')}</Caption>
            {summary.projects.map((row) => (
              <div
                key={row.project === '' ? 'folded' : row.project}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 10, ...mono(11.5) }}
              >
                <span style={row.project === '' ? { color: 'var(--tx3)' } : {}}>
                  {row.project === ''
                    ? t('history.foldedProjects', { count: row.folded ?? 0 })
                    : row.project}
                </span>
                <span>
                  {row.tokens.confidence === 'exact' ? '' : '≈'}
                  {formatTokens(row.tokens.value)}
                </span>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}

const PROVIDER = { claude: 'Claude', codex: 'Codex' } as const

function Caption({ children }: { children: string }) {
  return (
    <div
      style={{
        ...mono(10),
        letterSpacing: '.14em',
        textTransform: 'uppercase',
        color: 'var(--tx3)',
      }}
    >
      {children}
    </div>
  )
}

/** «Пятница, 7 августа» — подстановка приехавшей метки в постоянный формат. */
function dayTitle(at: number): string {
  const text = new Date(at).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}
