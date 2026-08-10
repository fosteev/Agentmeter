import type { SpendScreen } from '@agentmeter/ipc'
import { CacheRebuilds } from './CacheRebuilds.tsx'
import { SpendCategoryTable, CATEGORY_GRID, mono } from './SpendCategoryTable.tsx'
import { formatTokens, t } from '../format.ts'
import { hatch } from '../paint.ts'

/**
 * Вкладка «Развёртка» — раздел 5 макета (4.2).
 *
 * Экран отвечает на один вопрос: что из сегодняшнего расхода вызвано работой, а
 * что — просто тем, что у вас включено. Поэтому слева и справа не два списка
 * рядом, а две части **одного** итога: полоса наверху делит его пополам, и обе
 * колонки — её раскрытие.
 *
 * Ничего не считается здесь, кроме длины полос внутри своей диаграммы: доли,
 * средние за сессию и множитель перечитывания приезжают посчитанными (правило
 * 3.0). Единственная арифметика окна — ширина в процентах от максимума колонки.
 */
export interface BreakdownTabProps {
  screen: SpendScreen | null
  onScopeChange: (scope: 'day' | 'session') => void
}

const TOOL_GRID = '1fr 74px 74px 84px'

export function BreakdownTab({ screen, onScopeChange }: BreakdownTabProps) {
  if (screen === null || screen.emptyIndex || screen.emptyScope || screen.split === undefined) {
    return (
      <div
        data-breakdown-empty
        style={{
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          color: 'var(--tx2)',
          fontSize: 12.5,
        }}
      >
        {screen?.emptyIndex === false ? t('breakdown.emptyScope') : t('breakdown.emptyIndex')}
      </div>
    )
  }

  const [recurring, marginal] = screen.split.slices
  const perSession = screen.scope === 'session'

  return (
    <div data-breakdown style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{t('breakdown.title')}</div>
            <div
              style={{ fontSize: 12.5, color: 'var(--tx2)', maxWidth: 640, lineHeight: 1.5 }}
            >
              {t('breakdown.lead')}
            </div>
          </div>
          <div
            style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--s1)', borderRadius: 6 }}
          >
            {(['day', 'session'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                data-breakdown-scope={scope}
                aria-pressed={screen.scope === scope}
                onClick={() => onScopeChange(scope)}
                style={{
                  padding: '5px 11px',
                  fontSize: 11.5,
                  borderRadius: 4,
                  border: 'none',
                  cursor: 'pointer',
                  background: screen.scope === scope ? 'var(--s2)' : 'transparent',
                  color: screen.scope === scope ? 'var(--tx)' : 'var(--tx2)',
                }}
              >
                {t(scope === 'day' ? 'breakdown.scopeDay' : 'breakdown.scopeSession')}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${recurring!.share * 100}fr ${marginal!.share * 100}fr`,
            gap: 3,
          }}
        >
          {[recurring!, marginal!].map((slice) => {
            const own = slice.kind === 'recurring'
            return (
              <div key={slice.kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span
                    style={{
                      ...mono(10),
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      color: own ? 'var(--warn)' : 'var(--codex)',
                    }}
                  >
                    {own
                      ? t('breakdown.recurringAxis', { count: screen.sessions })
                      : t('breakdown.marginalAxis')}
                  </span>
                  <span
                    data-breakdown-slice={slice.kind}
                    style={{
                      ...mono(13, 'right'),
                      fontWeight: 600,
                      color: own ? 'var(--warn)' : 'var(--codex)',
                    }}
                  >
                    {t('split.value', {
                      tokens: `${slice.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(slice.tokens.value)}`,
                      percent: Math.round(slice.share * 100),
                    })}
                  </span>
                </div>
                <div
                  style={{
                    height: 34,
                    borderRadius: own ? '6px 0 0 6px' : '0 6px 6px 0',
                    background: own ? hatch('var(--warn)') : 'var(--codex)',
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 0 }}>
        <div
          style={{
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            borderRight: '1px solid var(--line)',
            background: 'color-mix(in oklch, var(--warn) 3.5%, transparent)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span
              style={{
                ...mono(10),
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: 'var(--tx3)',
              }}
            >
              {t('breakdown.left')}
            </span>
            <span style={{ ...mono(11), color: 'var(--warn)' }}>
              {t('breakdown.perSessionTotal', {
                tokens: formatTokens(screen.beforeFirstWord.perSession.value),
              })}
            </span>
          </div>
          <Header grid={CATEGORY_GRID} labels={[
            t('breakdown.columnCategory'),
            t('breakdown.columnPerSession'),
            t('breakdown.columnUsed'),
            perSession ? t('breakdown.columnPerSession') : t('breakdown.columnPeriod'),
          ]} />
          <SpendCategoryTable rows={screen.recurring} />
          {(screen.advice ?? []).map((advice) => (
            <div
              key={advice.source}
              data-breakdown-advice={advice.source}
              style={{
                padding: '10px 12px',
                border: '1px dashed color-mix(in oklch, var(--alarm) 55%, transparent)',
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: 'color-mix(in oklch, var(--alarm) 7%, transparent)',
              }}
              title={advice.tokens.caveat}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ ...mono(11.5), color: 'var(--alarm)' }}>{advice.headline}</span>
                <span style={{ ...mono(12), color: 'var(--alarm)', fontWeight: 600 }}>
                  −{advice.tokens.confidence === 'exact' ? '' : '≈'}
                  {formatTokens(advice.tokens.value)}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
                {advice.text}
              </div>
              {advice.hidden === undefined ? null : (
                <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
                  {t('breakdown.adviceHidden', { count: advice.hidden })}
                </div>
              )}
            </div>
          ))}
          <div
            data-breakdown-total="before-first-word"
            style={{
              display: 'grid',
              gridTemplateColumns: CATEGORY_GRID,
              gap: 12,
              alignItems: 'center',
              borderTop: '1px solid var(--line)',
              paddingTop: 11,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('breakdown.beforeFirstWord')}</span>
            <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
              {formatTokens(screen.beforeFirstWord.perSession.value)}
            </span>
            <span />
            <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
              {screen.beforeFirstWord.period.confidence === 'exact' ? '' : '≈'}
              {formatTokens(screen.beforeFirstWord.period.value)}
            </span>
          </div>
          <div
            data-breakdown-total="reread"
            style={{ display: 'grid', gridTemplateColumns: CATEGORY_GRID, gap: 12, alignItems: 'center' }}
          >
            <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
              {t('breakdown.reread')}{' '}
              <span style={{ ...mono(10.5), color: 'var(--tx3)' }}>
                {t('breakdown.rereadHint', { count: screen.reread.times })}
              </span>
            </span>
            <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>
              {t('breakdown.rereadTimes', { count: screen.reread.times })}
            </span>
            <span />
            <span style={{ ...mono(12, 'right'), fontWeight: 600, color: 'var(--warn)' }}>
              {screen.reread.tokens.confidence === 'exact' ? '' : '≈'}
              {formatTokens(screen.reread.tokens.value)}
            </span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span
              style={{
                ...mono(10),
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: 'var(--tx3)',
              }}
            >
              {t('breakdown.right')}
            </span>
            <span style={{ ...mono(11), color: 'var(--tx2)' }}>
              {t('breakdown.calls', { count: screen.toolCalls })}
            </span>
          </div>
          <Header grid={TOOL_GRID} labels={[
            t('breakdown.columnTool'),
            t('breakdown.columnCalls'),
            t('breakdown.columnAverage'),
            t('breakdown.columnTotal'),
          ]} />
          <ToolTable screen={screen} />
        </div>
      </div>
      {screen.rebuilds === undefined ? null : (
        <div style={{ padding: '20px 24px 0' }}>
          <CacheRebuilds rebuilds={screen.rebuilds} />
        </div>
      )}
      <div
        style={{
          padding: '12px 24px 20px',
          fontSize: 11.5,
          color: 'var(--tx2)',
          lineHeight: 1.55,
        }}
      >
        {t('breakdown.footer')}
      </div>
    </div>
  )
}

function ToolTable({ screen }: { screen: SpendScreen }) {
  const maximum = Math.max(0, ...screen.tools.map((row) => row.marginal.value))

  return (
    <div data-spend-tools style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {screen.tools.map((row) => (
        <div
          key={row.key}
          data-spend-tool={row.key}
          style={{ display: 'grid', gridTemplateColumns: TOOL_GRID, gap: 12, alignItems: 'center' }}
          title={row.marginal.caveat}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            <span style={{ fontSize: 12.5 }}>{row.label}</span>
            <div style={{ height: 8, borderRadius: 2, background: 'var(--s2)', overflow: 'hidden' }}>
              <div
                data-spend-tool-fill={row.key}
                style={{
                  width: `${maximum === 0 ? 0 : (row.marginal.value / maximum) * 100}%`,
                  height: '100%',
                  background:
                    row.marginal.confidence === 'exact' ? 'var(--codex)' : hatch('var(--codex)'),
                }}
              />
            </div>
          </div>
          <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>{row.calls}</span>
          <span style={{ ...mono(11, 'right'), color: 'var(--tx3)' }}>
            {formatTokens(row.calls === 0 ? 0 : Math.round(row.marginal.value / row.calls))}
          </span>
          <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>
            {row.marginal.confidence === 'exact' ? '' : '≈'}
            {formatTokens(row.marginal.value)}
          </span>
        </div>
      ))}
      <div
        data-breakdown-total="calls"
        style={{
          display: 'grid',
          gridTemplateColumns: TOOL_GRID,
          gap: 12,
          alignItems: 'center',
          borderTop: '1px solid var(--line)',
          paddingTop: 11,
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('breakdown.totalCalls')}</span>
        <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>{screen.toolCalls}</span>
        <span />
        <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
          {formatTokens(screen.tools.reduce((sum, row) => sum + row.marginal.value, 0))}
        </span>
      </div>
    </div>
  )
}

function Header({ grid, labels }: { grid: string; labels: string[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: grid,
        gap: 12,
        paddingBottom: 2,
        borderBottom: '1px solid var(--line)',
        ...mono(10),
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'var(--tx3)',
      }}
    >
      {labels.map((label, index) => (
        <span key={label} style={{ textAlign: index === 0 ? undefined : 'right' }}>
          {label}
        </span>
      ))}
    </div>
  )
}
