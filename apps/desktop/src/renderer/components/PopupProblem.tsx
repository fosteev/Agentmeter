import type { Provider } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupShell } from './PopupShell.tsx'

// Ошибка чтения — строки 1277–1286 макета. Обычный список намеренно не
// остаётся под предупреждением: частичные цифры выглядят полноценными раньше,
// чем пользователь успевает прочитать, чего именно в них не хватает.
//
// Отказ пересборки (7.2) показывается этим же экраном и по той же причине:
// прежние числа под прежним «обновлено 2 с назад» после нажатия на кнопку врут
// дважды — и цифрами, и временем.

export interface PopupProblemProps {
  snapshot: TraySnapshot
  onOpenWindow?: (() => void) | undefined
  /**
   * Отказ пересборки снимка, дословно (7.2).
   *
   * Не `SourceProblem`: у отказа нет ни провайдера, ни пути, и подделка под них
   * назвала бы виноватым источник, который ни при чём.
   */
  failure?: string | undefined
  /** Повторить пересборку — то же действие, что у кнопки в шапке. */
  onRetry?: (() => void) | undefined
}

const PROVIDER: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export function PopupProblem({ snapshot, onOpenWindow, failure, onRetry }: PopupProblemProps) {
  const { problems, today } = snapshot
  if (problems.length === 0 && failure === undefined) return null
  // Недоступными могут оказаться оба источника разом, и показать один значит
  // сказать «цифры Codex неполные», умолчав, что и Claude не прочитан. Макет
  // рисует одну строку, потому что рисует один случай, а не потому, что второй
  // невозможен.
  const broken = problems.map((problem) => PROVIDER[problem.provider]).join(t('popup.and'))
  // Отказ пересборки, если он есть, стоит первым: он про то нажатие, которое
  // человек только что сделал, а недоступный источник — про то, что было и до
  // него. Молча выбрать одно из двух нельзя, оба остаются на экране.
  const headline =
    failure === undefined ? t('popup.brokenLogs', { names: broken }) : t('popup.refreshFailed')
  const details = [
    ...(failure === undefined ? [] : [failure]),
    ...problems.map((problem) => `${problem.code} ${problem.path}`),
  ]
  const consequence = [
    ...(failure === undefined ? [] : [t('popup.refreshStale')]),
    ...problems.map((problem) => problem.consequence),
  ].join(' ')

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
        <div style={{ fontSize: 13, color: 'var(--alarm)' }}>{headline}</div>
        {details.map((detail) => (
          <div
            key={detail}
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
            {detail}
          </div>
        ))}
        <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 }}>{consequence}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {problems.length === 0 ? null : (
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
          )}
          <button
            type="button"
            data-popup-action="retry"
            // Что повторять — зависит от того, что отказало. Отказала
            // пересборка — повторяется она, тем же вызовом, что у кнопки в
            // шапке. Не прочитались логи — повторяется чтение: пересборка
            // снимка из индекса, в котором их нет, вернёт ту же ошибку.
            onClick={() => {
              if (failure !== undefined && onRetry !== undefined) onRetry()
              else void window.agentmeter['index:rebuild']()
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
