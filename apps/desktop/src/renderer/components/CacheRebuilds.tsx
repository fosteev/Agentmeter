import type { CacheRebuilds as Rebuilds, Measured } from '@agentmeter/ipc'
import { clock, formatTokens, t } from '../format.ts'
import { span } from '../time.ts'
import { mono } from './SpendCategoryTable.tsx'

/**
 * «Переплата за паузу» — раздел 10 макета (4.4), блок внутри «Развёртки».
 *
 * Считается здесь ровно одно — длина полосок внутри своих двух диаграмм: доля
 * строки от самой большой в её таблице. Числа, доля от расхода за период и
 * состав четырёх строк приезжают посчитанными (правило 3.0).
 *
 * Штриховки в блоке нет: здесь нечего оценивать. Знак `≈` появится только от
 * восстановленных запросов (1.3), и приезжает он в `Measured`, а не решается
 * тут.
 *
 * Строки макета «Показать эти 24 паузы в ленте» нет намеренно: фильтра «паузы»
 * у ленты не существует, а кнопка, которая ничего не меняет, хуже её
 * отсутствия — то же правило, что у тумблера автозапуска в 3.6.
 */
export interface CacheRebuildsProps {
  rebuilds: Rebuilds
}

const REBUILD_GRID = '1fr 46px 68px'
const PAUSE_GRID = '96px 1fr 46px 68px'

export function CacheRebuilds({ rebuilds }: CacheRebuildsProps) {
  const ttl = span(rebuilds.ttlMs)
  const rows = [
    { key: 'start', label: t('rebuild.start'), group: rebuilds.start, alarm: false },
    { key: 'pause', label: t('rebuild.pause', { ttl }), group: rebuilds.pause, alarm: true },
    { key: 'early', label: t('rebuild.early'), group: rebuilds.early, alarm: false },
    { key: 'compact', label: t('rebuild.compact'), group: rebuilds.compact, alarm: false },
  ].filter((row) => row.group.count > 0)
  const widest = Math.max(0, ...rows.map((row) => row.group.tokens.value))
  const widestBucket = Math.max(0, ...rebuilds.buckets.map((bucket) => bucket.tokens.value))

  return (
    <div
      data-cache-rebuilds
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{t('rebuild.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5, maxWidth: 360 }}>
            {t('rebuild.subtitle', { ttl })}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <span
            data-cache-rebuilds-total
            style={{ ...mono(20), fontWeight: 600, color: 'var(--alarm)' }}
          >
            {sign(rebuilds.total.tokens)}
            {formatTokens(rebuilds.total.tokens.value)}
          </span>
          <span style={{ ...mono(10.5), color: 'var(--tx3)' }}>
            {t('rebuild.share', { percent: Math.round(rebuilds.share * 100) })}
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          borderTop: '1px solid var(--line)',
          paddingTop: 14,
        }}
      >
        <Header grid={REBUILD_GRID} first={t('rebuild.tableTitle')} />
        {rows.map((row) => (
          <div
            key={row.key}
            data-cache-rebuild={row.key}
            style={{ display: 'grid', gridTemplateColumns: REBUILD_GRID, gap: 12, alignItems: 'center' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, color: row.alarm ? 'var(--alarm)' : 'var(--tx2)' }}>
                {row.label}
              </span>
              <Bar share={widest === 0 ? 0 : row.group.tokens.value / widest} alarm={row.alarm} />
            </div>
            <span style={{ ...mono(12, 'right'), color: row.alarm ? 'var(--alarm)' : 'var(--tx2)' }}>
              {row.group.count}
            </span>
            <span
              style={{
                ...mono(12, 'right'),
                // Насыщенность и цвет только у строки паузы: макет выделяет ею
                // единственную строку, на которую можно повлиять. Написать
                // `fontWeight: 400` вместо отсутствия свойства значит завести
                // число, которого в макете нет ни разу.
                ...(row.alarm ? { fontWeight: 600, color: 'var(--alarm)' } : {}),
              }}
            >
              {sign(row.group.tokens)}
              {formatTokens(row.group.tokens.value)}
            </span>
          </div>
        ))}
        <div
          data-cache-rebuild="total"
          style={{
            display: 'grid',
            gridTemplateColumns: REBUILD_GRID,
            gap: 12,
            alignItems: 'center',
            borderTop: '1px solid var(--line)',
            paddingTop: 10,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('rebuild.total')}</span>
          <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>{rebuilds.total.count}</span>
          <span style={{ ...mono(13, 'right'), fontWeight: 600 }}>
            {sign(rebuilds.total.tokens)}
            {formatTokens(rebuilds.total.tokens.value)}
          </span>
        </div>
      </div>

      {rebuilds.buckets.length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            borderTop: '1px solid var(--line)',
            paddingTop: 14,
          }}
        >
          <Header grid={PAUSE_GRID} first={t('rebuild.pauseTitle')} spacer />
          {rebuilds.buckets.map((bucket) => (
            <div
              key={bucket.fromMs}
              data-pause-bucket={bucket.fromMs}
              style={{ display: 'grid', gridTemplateColumns: PAUSE_GRID, gap: 12, alignItems: 'center' }}
            >
              <span style={{ ...mono(11.5), color: 'var(--tx2)' }}>
                {bucket.toMs === null
                  ? t('rebuild.bucketOver', { from: span(bucket.fromMs) })
                  : t('rebuild.bucketRange', {
                      from: span(bucket.fromMs),
                      to: span(bucket.toMs),
                    })}
              </span>
              <Bar
                share={widestBucket === 0 ? 0 : bucket.tokens.value / widestBucket}
                alarm
              />
              <span style={{ ...mono(11.5, 'right'), color: 'var(--tx2)' }}>{bucket.count}</span>
              <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>
                {sign(bucket.tokens)}
                {formatTokens(bucket.tokens.value)}
              </span>
            </div>
          ))}
          <div
            data-pause-bucket="total"
            style={{
              display: 'grid',
              gridTemplateColumns: PAUSE_GRID,
              gap: 12,
              alignItems: 'center',
              borderTop: '1px solid var(--line)',
              paddingTop: 10,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('rebuild.bucketTotal')}</span>
            <span />
            <span style={{ ...mono(12, 'right'), fontWeight: 600 }}>{rebuilds.pause.count}</span>
            <span style={{ ...mono(13, 'right'), fontWeight: 600, color: 'var(--alarm)' }}>
              {sign(rebuilds.pause.tokens)}
              {formatTokens(rebuilds.pause.tokens.value)}
            </span>
          </div>
        </div>
      )}

      {rebuilds.worst === undefined ? null : (
        <div
          data-cache-rebuild-worst
          style={{
            borderTop: '1px solid var(--line)',
            paddingTop: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 12.5 }}>
              {t('rebuild.worst', {
                count: 1,
                duration: span(rebuilds.worst.pauseMs),
              })}
            </span>
            <span style={{ ...mono(12.5, 'right'), fontWeight: 600, color: 'var(--alarm)' }}>
              {sign(rebuilds.worst.tokens)}
              {formatTokens(rebuilds.worst.tokens.value)}
            </span>
          </div>
          <div style={{ ...mono(11), color: 'var(--tx2)' }}>
            {rebuilds.worst.branch === null
              ? t('rebuild.worstWhere', {
                  from: clock(rebuilds.worst.from),
                  to: clock(rebuilds.worst.to),
                  project: rebuilds.worst.project,
                })
              : t('rebuild.worstWhereBranch', {
                  from: clock(rebuilds.worst.from),
                  to: clock(rebuilds.worst.to),
                  project: rebuilds.worst.project,
                  branch: rebuilds.worst.branch,
                })}
          </div>
        </div>
      )}

      <div
        style={{
          borderTop: '1px solid var(--line)',
          paddingTop: 12,
          fontSize: 12,
          color: 'var(--tx2)',
          lineHeight: 1.5,
        }}
      >
        {t('rebuild.caveat')}
      </div>
    </div>
  )
}

function Header({ grid, first, spacer }: { grid: string; first: string; spacer?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: grid,
        gap: 12,
        ...mono(10),
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'var(--tx3)',
      }}
    >
      <span>{first}</span>
      {spacer === true ? <span /> : null}
      <span style={{ textAlign: 'right' }}>{t('rebuild.columnTimes')}</span>
      <span style={{ textAlign: 'right' }}>{t('rebuild.columnTokens')}</span>
    </div>
  )
}

function Bar({ share, alarm }: { share: number; alarm: boolean }) {
  return (
    <div style={{ height: 8, borderRadius: 2, background: 'var(--s2)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.round(share * 100)}%`,
          height: '100%',
          background: alarm ? 'var(--alarm)' : 'var(--tx3)',
        }}
      />
    </div>
  )
}

function sign(value: Measured): string {
  return value.confidence === 'exact' ? '' : '≈'
}
