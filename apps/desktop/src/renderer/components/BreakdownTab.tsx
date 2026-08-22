import type { SpendScreen, TodayFilter } from '@agentmeter/ipc'
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
  /**
   * Сужение, унаследованное от ленты. Экран обязан его назвать: молча суженная
   * развёртка читается как весь день. Отсюда же слова пустоты — «фильтр отсёк
   * всё» и «за период не работали» различимы только тем, был ли фильтр.
   */
  filter?: Pick<TodayFilter, 'provider' | 'project'>
  /**
   * День, открытый с «Истории», — начало его суток. Экран обязан назвать дату
   * тем же правилом, что фильтр выше: развёртка чужого дня без подписи
   * читается как сегодняшняя. Чип — он же кнопка возврата к текущему дню.
   */
  day?: number
  onDayReset?: () => void
}

const TOOL_GRID = '1fr 74px 74px 84px'

/** Имена продуктов — не переводятся, как в фильтре ленты. */
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const

/**
 * Четыре пустоты — четырьмя фразами: загрузка, несобранный индекс, период без
 * запросов и фильтр, отсёкший всё. Схлопни любые две — и одна из них соврёт:
 * до фикса здесь обычная загрузка вкладки объявляла «первичное индексирование».
 */
function emptyMessage(
  screen: SpendScreen | null,
  filtered: boolean,
): string {
  if (screen === null) return t('breakdown.loading')
  if (screen.emptyIndex) return t('breakdown.emptyIndex')
  if (screen.emptyScope) return t('breakdown.emptyScope')
  return filtered ? t('breakdown.emptyFilter') : t('breakdown.emptyScope')
}

export function BreakdownTab({ screen, onScopeChange, filter, day, onDayReset }: BreakdownTabProps) {
  const filterParts = [
    filter?.provider === undefined ? null : PROVIDER_NAMES[filter.provider],
    filter?.project,
  ].filter((part): part is string => part !== null && part !== undefined)

  const dayChip =
    day === undefined ? null : (
      <button
        type="button"
        data-breakdown-day={day}
        onClick={onDayReset}
        title={t('breakdown.dayReset')}
        style={{
          ...mono(10.5),
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid var(--line)',
          background: 'var(--s1)',
          color: 'var(--tx2)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {t('breakdown.dayNote', {
          date: new Date(day).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }),
        })}{' '}
        ×
      </button>
    )

  if (screen === null || screen.emptyIndex || screen.emptyScope || screen.split === undefined) {
    return (
      <div
        data-breakdown-empty
        style={{
          gridColumn: '1 / -1',
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 6,
          color: 'var(--tx2)',
          fontSize: 12.5,
        }}
      >
        {emptyMessage(screen, filterParts.length > 0)}
        {/* Чип и на пустом экране: развёртку чужого дня, где запросов не
            нашлось, иначе нечем ни опознать, ни вернуть к сегодняшней. */}
        {dayChip}
      </div>
    )
  }

  const [recurring, marginal] = screen.split.slices
  const perSession = screen.scope === 'session'

  return (
    <div
      data-breakdown
      style={{
        // Сетка окна — `1fr 300px` под ленту с боковой колонкой (`Window`).
        // У развёртки своей боковушки нет, и без явного захвата обеих колонок
        // экран рисуется в первой, оставляя справа 300 пустых точек: доли,
        // посчитанные под всю ширину, оказываются в колонке уже своей.
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {dayChip}
            {filterParts.length === 0 ? null : (
              <span
                data-breakdown-filter
                style={{ ...mono(10.5), color: 'var(--tx3)', whiteSpace: 'nowrap' }}
              >
                {t('breakdown.filterNote', { value: filterParts.join(' · ') })}
              </span>
            )}
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
        </div>

        {/*
          Подписи и полоса — две сетки, а не одна на две строки.

          У одной сетки минимум колонки равен минимуму её содержимого, и когда
          доля мала (5% постоянного — обычный день без MCP), подпись не даёт
          колонке сжаться: полоса рисуется шире своей доли, а подпись всё равно
          ломается в столбик. То есть единственное число, которое здесь обязано
          быть честным — длина, — врёт из-за текста над ним.

          Поэтому у полосы `minmax(0, …fr)`: доля и только доля. Подписи живут
          своей сеткой, где узкой колонке разрешено занять место под своё
          число (оно не сокращается — это расход), а подпись оси ужимается
          многоточием: она называет колонку, которую и так называет цвет.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                <div
                  key={slice.kind}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      ...mono(10),
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      color: own ? 'var(--warn)' : 'var(--codex)',
                      minWidth: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
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
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {t('split.value', {
                      tokens: `${slice.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(slice.tokens.value)}`,
                      percent: Math.round(slice.share * 100),
                    })}
                  </span>
                </div>
              )
            })}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(0, ${recurring!.share * 100}fr) minmax(0, ${marginal!.share * 100}fr)`,
              gap: 3,
            }}
          >
            {[recurring!, marginal!].map((slice) => {
              const own = slice.kind === 'recurring'
              return (
                <div
                  key={slice.kind}
                  data-breakdown-bar={slice.kind}
                  style={{
                    height: 34,
                    borderRadius: own ? '6px 0 0 6px' : '0 6px 6px 0',
                    background: own ? hatch('var(--warn)') : 'var(--codex)',
                  }}
                />
              )
            })}
          </div>
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
            {/* В ячейке — множитель, в подписи — счёт раз: ячейка стоит в
                колонке «За сессию», и счёт периода в ней значил бы, что каждая
                сессия перечитала префикс за все сессии сразу. */}
            <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>
              {t('breakdown.rereadTimes', { count: screen.reread.factor })}
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
  // Таблица рисуется только при собранном экране — срез там есть всегда.
  const marginal = screen.split!.slices[1]!

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
            {formatTokens(row.average ?? 0)}
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
        title={screen.toolTotal.caveat}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('breakdown.totalCalls')}</span>
        <span style={{ ...mono(12, 'right'), color: 'var(--tx2)' }}>{screen.toolCalls}</span>
        <span />
        <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
          {screen.toolTotal.confidence === 'exact' ? '' : '≈'}
          {formatTokens(screen.toolTotal.value)}
        </span>
      </div>
      {/*
        Строки сходимости (макет, 1141–1150): без них ось «Разовый · по
        вызовам» обещает раскрытие, а колонка объясняет доли процента. Итоговая
        строка берёт число из среза полосы, а не складывает две верхние — один
        источник, не два (правило 4.1).
      */}
      {screen.marginalRest === undefined ? null : (
        <div
          data-breakdown-total="marginal-rest"
          style={{ display: 'grid', gridTemplateColumns: TOOL_GRID, gap: 12, alignItems: 'center' }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
            {t('breakdown.marginalRest')}{' '}
            <span style={{ ...mono(10.5), color: 'var(--tx3)' }}>
              {t('breakdown.marginalRestRequests', { count: screen.marginalRest.requests })}
            </span>
          </span>
          <span />
          <span />
          <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>
            {screen.marginalRest.tokens.confidence === 'exact' ? '' : '≈'}
            {formatTokens(screen.marginalRest.tokens.value)}
          </span>
        </div>
      )}
      <div
        data-breakdown-total="marginal"
        style={{
          display: 'grid',
          gridTemplateColumns: TOOL_GRID,
          gap: 12,
          alignItems: 'center',
          borderTop: '1px solid var(--line)',
          paddingTop: 11,
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>
          {t(screen.scope === 'session' ? 'breakdown.marginalTotalSession' : 'breakdown.marginalTotalDay')}
        </span>
        <span />
        <span />
        <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
          {marginal.tokens.confidence === 'exact' ? '' : '≈'}
          {formatTokens(marginal.tokens.value)}
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
