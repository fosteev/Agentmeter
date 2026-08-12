import type { TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { ago } from '../time.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'
import { PopupShell } from './PopupShell.tsx'

// Пустое состояние — строки 1254–1262 макета. Нулевая сумма в подвале
// намеренно скрыта: до первого запуска это не измерение расхода, а отсутствие
// данных, и крупный ноль превращал бы подсказку о следующем шаге в сноску.

export interface PopupEmptyProps {
  snapshot: TraySnapshot
  now: number
  onOpenWindow?: (() => void) | undefined
}

export function PopupEmpty({ snapshot, now, onOpenWindow }: PopupEmptyProps) {
  const { at, today } = snapshot
  const total = today.total.value === 0 ? '' : formatTokens(today.total.value)

  return (
    <PopupShell>
      <PopupHeader updated={t('popup.updatedAgo', { ago: ago(now - at) })} />

      <div
        style={{
          // Пустое состояние живёт объяснением, а не размером: раньше текст
          // висел посреди шестисот точек пустоты, теперь окно ровно по нему.
          flex: '1 1 auto',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 22, opacity: 0.4 }}
        >
          {[0, 1, 2].map((bar) => (
            <div key={bar} style={{ width: 6, height: 6, background: 'var(--tx3)' }} />
          ))}
        </div>
        <div style={{ fontSize: 13 }}>{t('popup.neverRan')}</div>
        <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
          {t('popup.neverRanHint')}
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
