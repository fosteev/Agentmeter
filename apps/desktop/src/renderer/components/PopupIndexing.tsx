import type { IndexProgress, TraySnapshot } from '@agentmeter/ipc'
import { locale, formatTokens, plural } from '../format.ts'
import { ago, span } from '../time.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'

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
    return `≈ ${new Intl.NumberFormat(locale()).format(Math.round(ms / 1000))} с`
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
    <div
      style={{
        width: 400,
        height: 600,
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <PopupHeader updated={`обновлено ${ago(now - at)}`} />

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
        }}
      >
        <div style={{ fontSize: 13 }}>Первичное индексирование</div>
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
              {megabytes(progress.bytesDone)} / {megabytes(progress.bytesTotal)} МБ
            </span>
            <span>{eta}</span>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
          Читаем только локальные логи. Сегодняшний день уже доступен — история дособерётся в фоне.
        </div>
      </div>

      <PopupFooter
        total={total}
        summary={`${plural(today.sessions, ['сессия', 'сессии', 'сессий'])} · ${plural(today.projects, ['проект', 'проекта', 'проектов'])}`}
        onOpenWindow={onOpenWindow}
      />
    </div>
  )
}
