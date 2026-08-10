import type { TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, plural } from '../format.ts'
import { ago } from '../time.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'

// Пустое состояние — строки 1203–1211 макета. Нулевая сумма в подвале
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
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
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
        <div style={{ fontSize: 13 }}>Агенты ещё не запускались</div>
        <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
          Запустите Claude Code или Codex — Agentmeter подхватит сессию сам, за пару секунд.
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
