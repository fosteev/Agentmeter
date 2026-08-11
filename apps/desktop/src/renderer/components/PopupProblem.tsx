import type { Provider } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupShell } from './PopupShell.tsx'

// Ошибка чтения — строки 1226–1235 макета. Обычный список намеренно не
// остаётся под предупреждением: частичные цифры выглядят полноценными раньше,
// чем пользователь успевает прочитать, чего именно в них не хватает.

export interface PopupProblemProps {
  snapshot: TraySnapshot
  onOpenWindow?: (() => void) | undefined
}

const PROVIDER: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export function PopupProblem({ snapshot, onOpenWindow }: PopupProblemProps) {
  const { problems, today } = snapshot
  if (problems.length === 0) return null
  // Недоступными могут оказаться оба источника разом, и показать один значит
  // сказать «цифры Codex неполные», умолчав, что и Claude не прочитан. Макет
  // рисует одну строку, потому что рисует один случай, а не потому, что второй
  // невозможен.
  const broken = problems.map((problem) => PROVIDER[problem.provider]).join(t('popup.and'))

  return (
    <PopupShell>
      <div
        style={{
          padding: '11px 14px',
          borderBottom: '1px solid var(--line)',
          fontSize: 12.5,
          fontWeight: 600,
          background: 'var(--s1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Agentmeter</span>
        <span
          aria-label={t('popup.readError')}
          style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--alarm)' }}
        />
      </div>

      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          // Путей может быть два, и каждый в несколько строк: этот экран —
          // единственный, который упирается в потолок не списком агентов.
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--alarm)' }}>
          {t('popup.brokenLogs', { names: broken })}
        </div>
        {problems.map((problem) => (
          <div
            key={`${problem.provider}-${problem.path}`}
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              color: 'var(--tx2)',
              padding: '8px 10px',
              background: 'var(--s1)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              wordBreak: 'break-all',
            }}
          >
            {problem.code} {problem.path}
          </div>
        ))}
        <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
          {problems.map((problem) => problem.consequence).join(' ')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              void window.agentmeter['window:open']({ tab: 'settings' })
            }}
            style={{
              fontFamily: 'inherit',
              fontSize: 11.5,
              padding: '5px 10px',
              border: '1px solid var(--line)',
              borderRadius: 5,
              color: 'var(--tx)',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            {t('popup.setPath')}
          </button>
          <button
            type="button"
            onClick={() => {
              void window.agentmeter['index:rebuild']()
            }}
            style={{
              fontFamily: 'inherit',
              fontSize: 11.5,
              padding: '5px 10px',
              border: '1px solid var(--line)',
              borderRadius: 5,
              color: 'var(--tx2)',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            {t('popup.retry')}
          </button>
        </div>
      </div>

      <PopupFooter
        total={`${today.total.confidence === 'exact' ? '' : '≈'}${formatTokens(today.total.value)}`}
        summary={`${t('today.sessions', { count: today.sessions })} · ${t('today.projectsPlain', { count: today.projects })}`}
        onOpenWindow={onOpenWindow}
      />
    </PopupShell>
  )
}
