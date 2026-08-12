import type { Entrypoint, LimitReportRow } from '@agentmeter/core'
import type { LiveAgent, TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { ago, span } from '../time.ts'
import { AGENT_STATUS, AgentRow } from './AgentRow.tsx'
import { LimitsAside } from './LimitsAside.tsx'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'
import { PopupEmpty } from './PopupEmpty.tsx'
import { PopupIdle } from './PopupIdle.tsx'
import { PopupIndexing } from './PopupIndexing.tsx'
import { PopupLimit } from './PopupLimit.tsx'
import { PopupProblem } from './PopupProblem.tsx'
import { PopupShell } from './PopupShell.tsx'
import { SectionTitle } from './SectionTitle.tsx'

// Попап целиком — строки 332–472 макета (тёмный) и 479–593 (светлый). Сборка:
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
  /**
   * Спросить лимиты у Anthropic (6.3). Кнопка рисуется только при включённом
   * источнике, поэтому проп необязателен: в попапе без него блок лимитов
   * выглядит ровно так, как до этапа.
   */
  onAskLimits?: (() => void) | undefined
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

/** Высота строки агента вместе с отбивкой: 40 из макета плюс gap списка. */
const ROW = 42
/** Сколько строк списка видно даже в самом тесном случае. */
const MIN_ROWS = 2

export function Popup({ snapshot, now = Date.now(), onOpenWindow, onAskLimits }: PopupProps) {
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

  const { at, agents, limits, limitsSource, today } = snapshot

  return (
    <PopupShell>
      <PopupHeader updated={t('popup.updatedAgo', { ago: ago(now - at) })} />

      <div style={{ flex: '1 1 auto', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/*
          Единственное, что здесь растёт без предела, — список агентов: открытых
          чатов бывает и десять. Поэтому сжимается тоже только он, а лимиты и
          подвал стоят на месте. Раньше список выдавливал полосы лимитов за
          нижний край, и попап переставал отвечать на вопрос, ради которого его
          открывают. Высота не зашита числом: сколько строк поместилось —
          столько и видно, остальные под скроллом, и с двумя окнами лимита их
          помещается больше, чем с четырьмя.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: '0 1 auto', minHeight: 0 }}>
          <div style={{ flex: 'none' }}>
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
          </div>

          <div
            style={{
              padding: '6px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              // Две строки — пол, ниже которого список не сжимается: раздел,
              // ужатый до нуля, выглядит как «никто не работает», хотя счётчик
              // в заголовке говорит обратное. Но пол не выше самого списка:
              // окно теперь ровно по содержимому, и зашитые две строки при
              // одном агенте стали бы пустой полосой под ним.
              minHeight: Math.min(agents.length, MIN_ROWS) * ROW,
              overflowY: 'auto',
              scrollbarWidth: 'thin',
            }}
          >
            {agents.map((agent) => (
              <AgentRow
                key={agent.sessionId}
                density="popup"
                provider={agent.provider}
                project={agent.project}
                status={AGENT_STATUS[agent.state]}
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
        </div>

        <div style={{ flex: 'none' }}>
          <SectionTitle
            title={t('popup.limits')}
            padding="16px 14px 4px"
            aside={
              <LimitsAside
                limits={limits}
                source={limitsSource}
                now={now}
                onAsk={onAskLimits}
              />
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
      </div>

      <PopupFooter
        total={`${today.total.confidence === 'exact' ? '' : '≈'}${formatTokens(today.total.value)}`}
        summary={`${t('today.sessions', { count: today.sessions })} · ${t('today.projectsPlain', { count: today.projects })}`}
        onOpenWindow={onOpenWindow}
      />
    </PopupShell>
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
