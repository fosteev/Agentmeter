import type { IndexProgress, TraySnapshot } from '@agentmeter/ipc'
import { locale, formatTokens, t } from '../format.ts'
import { ago, span } from '../time.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'
import { PopupShell } from './PopupShell.tsx'

// Первичное индексирование — строки 1213–1224 макета. Ширина считается по
// байтам, а не по файлам: один транскрипт может быть тяжелее другого на три
// порядка, и счётчик файлов давал бы правдоподобную, но лживую полосу.

export interface PopupIndexingProps {
  snapshot: TraySnapshot
  progress: IndexProgress
  now: number
  onOpenWindow?: (() => void) | undefined
}

/**
 * Мегабайты и секунды — не токены, и общий форматтер им не годится.
 *
 * `formatTokens` навешивает суффиксы тысяч: каталог логов на гигабайт превратил
 * бы «1200 / 1400 МБ» в «1.2k / 1.4k МБ», а час ожидания — в «3.6k с». Ошибка
 * тихая: на сегодняшних 570 МБ и сорока секундах она не видна вовсе.
 */
function megabytes(bytes: number): string {
  return new Intl.NumberFormat(locale()).format(Math.round(bytes / (1024 * 1024)))
}

/**
 * Оставшееся время. Под минутой — секундами, как в макете («≈ 40 с»); дальше
 * общим `span`, потому что «≈ 400 с» никто не читает.
 */
function remaining(ms: number): string {
  if (ms < 60_000) {
    return t('popup.etaSeconds', {
      seconds: new Intl.NumberFormat(locale()).format(Math.round(ms / 1000)),
    })
  }
  return `≈ ${span(ms)}`
}

export function PopupIndexing({ snapshot, progress, now, onOpenWindow }: PopupIndexingProps) {
  const { at, today } = snapshot
  const percent =
    progress.bytesTotal === 0
      ? 0
      : Math.round(Math.max(0, Math.min(1, progress.bytesDone / progress.bytesTotal)) * 100)
  const eta = progress.etaMs === null ? '' : remaining(progress.etaMs)
  const total = today.total.value === 0 ? '' : formatTokens(today.total.value)

  return (
    <PopupShell>
      <PopupHeader updated={t('popup.updatedAgo', { ago: ago(now - at) })} />

      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
        }}
      >
        <div style={{ fontSize: 13 }}>{t('popup.indexing')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: 'var(--s2)',
              overflow: 'hidden',
            }}
          >
            <div style={{ width: `${percent}%`, height: '100%', background: 'var(--codex)' }} />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              color: 'var(--tx2)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>
              {t('popup.megabytes', {
                done: megabytes(progress.bytesDone),
                total: megabytes(progress.bytesTotal),
              })}
            </span>
            <span>{eta}</span>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
          {t('popup.indexingHint')}
        </div>
      </div>

      <PopupFooter
        total={total}
        summary={`${t('today.sessions', { count: today.sessions })} · ${t('today.projectsPlain', { count: today.projects })}`}
        onOpenWindow={onOpenWindow}
      />
    </PopupShell>
  )
}
