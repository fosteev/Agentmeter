import type { Entrypoint, LimitReportRow } from '@agentmeter/core'
import type { LiveAgent, TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { ago, span } from '../time.ts'
import { AgentRow, type AgentStatus } from './AgentRow.tsx'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'
import { PopupEmpty } from './PopupEmpty.tsx'
import { PopupIdle } from './PopupIdle.tsx'
import { PopupIndexing } from './PopupIndexing.tsx'
import { PopupLimit } from './PopupLimit.tsx'
import { PopupProblem } from './PopupProblem.tsx'
import { SectionTitle } from './SectionTitle.tsx'

// Попап целиком — строки 332–452 макета (тёмный) и 459–554 (светлый). Сборка:
// шапка, «Сейчас работают» со списком, «Лимиты» с полосами, подвал за сутки.
//
// Единственное, что здесь считается, — длительности и проценты ширины. Токены
// приезжают готовыми: `TraySnapshot` несёт и сумму за сутки, и признак
// точности, потому что посчитанное дважды однажды разойдётся, и пользователь
// увидит два числа без указания, какое настоящее.

export interface PopupProps {
  snapshot: TraySnapshot
  /**
   * Сейчас — для строки «обновлено N с назад». Параметром, а не `Date.now()`
   * внутри: на фикстуре с фиксированными метками тест иначе краснел бы по
   * календарю, а не по поломке.
   */
  now?: number | undefined
  onOpenWindow?: (() => void) | undefined
}

const STATUS: Record<LiveAgent['state'], AgentStatus> = {
  working: 'thinking',
  waiting: 'waiting',
  idle: 'idle',
  done: 'done',
}

/** Ключи, а не слова: длина названия окна проверяется потолком (3.8). */
const KIND_KEY = {
  fiveHour: 'limit.fiveHour',
  weekly: 'limit.weekly',
  monthly: 'limit.monthly',
  other: 'limit.other',
} as const satisfies Record<LimitReportRow['kind'], string>

// Точка входа коротким словом — как в макете («Opus 5 · VS Code», «· term»).
// `unknown` не показывается вовсе: пустое место честнее слова «неизвестно»,
// которое читалось бы как свойство сессии.
const ENTRYPOINT: Record<Entrypoint, string> = {
  cli: 'term',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  desktop: 'Desktop',
  sdk: 'SDK',
  exec: 'exec',
  unknown: '',
}

export function Popup({ snapshot, now = Date.now(), onOpenWindow }: PopupProps) {
  if (snapshot.problems.length > 0) {
    return <PopupProblem snapshot={snapshot} onOpenWindow={onOpenWindow} />
  }
  if (snapshot.indexing !== undefined && snapshot.indexing.phase !== 'done') {
    return (
      <PopupIndexing
        snapshot={snapshot}
        progress={snapshot.indexing}
        now={now}
        onOpenWindow={onOpenWindow}
      />
    )
  }
  if (snapshot.agents.length === 0 && snapshot.lastAgent === undefined) {
    return <PopupEmpty snapshot={snapshot} now={now} onOpenWindow={onOpenWindow} />
  }
  if (snapshot.agents.length === 0) {
    return <PopupIdle snapshot={snapshot} now={now} onOpenWindow={onOpenWindow} />
  }

  const { at, agents, limits, today } = snapshot

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
      <PopupHeader updated={t('popup.updatedAgo', { ago: ago(now - at) })} />

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <SectionTitle
          title={t('popup.working')}
          padding="14px 14px 4px"
          aside={
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 11,
                color: 'var(--tx2)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {agents.filter((agent) => agent.state !== 'done').length}
            </span>
          }
        />

        <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {agents.map((agent) => (
            <AgentRow
              key={agent.sessionId}
              density="popup"
              provider={agent.provider}
              project={agent.project}
              status={STATUS[agent.state]}
              tokens={agent.tokens}
              rate={agent.rate}
              approximate={agent.approximate}
              branch={agent.branch}
              duration={span(at - agent.startedAt)}
              endedAgo={agent.endedAt === undefined ? undefined : ago(at - agent.endedAt)}
              model={agent.model}
              entrypoint={ENTRYPOINT[agent.entrypoint] || undefined}
              context={context(agent)}
            />
          ))}
        </div>

        <SectionTitle
          title={t('popup.limits')}
          padding="16px 14px 4px"
          aside={
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10,
                color: 'var(--tx3)',
              }}
            >
              {t('popup.estimate')}
            </span>
          }
        />

        <div style={{ padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          {limits.map((window) => (
            <PopupLimit
              key={`${window.provider}-${window.kind}-${window.startsAt}`}
              provider={window.provider}
              title={t(KIND_KEY[window.kind])}
              percent={window.usedPercent}
              approximate={!window.exact}
              caption={caption(window, at)}
            />
          ))}
        </div>
      </div>

      <PopupFooter
        total={`${today.total.confidence === 'exact' ? '' : '≈'}${formatTokens(today.total.value)}`}
        summary={`${t('today.sessions', { count: today.sessions })} · ${t('today.projectsPlain', { count: today.projects })}`}
        onOpenWindow={onOpenWindow}
      />
    </div>
  )
}

/**
 * Заполнение контекстного окна для строки агента (2.6).
 *
 * Доля приезжает посчитанной, здесь только слова. Знак «≈» стоит и у процента,
 * и у размера окна: неизвестен именно размер, а не занятое — занятое написано в
 * логе. Причина дописывается текстом, как у окна лимита без процента: пометка
 * без объяснения заставляет гадать, что именно неточно.
 */
function context(
  agent: LiveAgent,
): { fill: number; approximate: boolean; hint: string } | undefined {
  const usage = agent.context
  if (usage === undefined) return undefined
  const estimate = usage.confidence !== 'exact'
  const sign = estimate ? '≈' : ''
  const head = t('popup.context', {
    sign,
    percent: Math.round(usage.fill * 100),
    used: formatTokens(usage.used),
    window: formatTokens(usage.window),
  })
  return {
    fill: usage.fill,
    approximate: estimate,
    hint: usage.caveat === undefined ? head : `${head} — ${usage.caveat}`,
  }
}

/**
 * Нижняя строка блока лимита.
 *
 * Когда процента нет, вместо времени сброса стоит причина: «неизвестно» обязано
 * быть сказано словами, иначе пустая полоса читается как «израсходовано нисколько».
 * Прогноз (2.3) дописывается только там, где до упора дело дойдёт раньше сброса —
 * иначе это пугающее число ни о чём.
 */
function caption(window: LimitReportRow, at: number): string {
  if (window.usedPercent === null) return window.unavailableReason ?? t('limit.unknownPercent')
  const reset = t('limit.resetsIn', { span: span(Math.max(0, window.resetsAt - at)) })
  const forecast = window.forecast
  if (forecast === null || forecast.resetsFirst || forecast.minutesToCap === null) return reset
  return t('limit.untilCap', { reset, span: span(forecast.minutesToCap * 60_000) })
}
