import type { Provider } from '@agentmeter/core'
import { formatTokens } from '../format.ts'

// Строка агента. Состояния из строк 145–171 макета:
// думает (пульс ок-точкой) · ждёт (контур warn) · завершён (гашение opacity .55,
// акцент tx3). Два сквозных различия заданы цветом акцента: Claude — янтарный,
// Codex — холодный. Подписей-дисклеймеров нет: точность видна по штриховке
// в LimitBar/BreakdownRow, здесь её нет.

// Четвёртое состояние — `idle` — макетом не нарисовано и добавлено в 2.2. Оно
// значит «ход у агента, но в логе тишина дольше порога»: так выглядят зависший
// инструмент, запрос разрешения и уснувший процесс. Точка у него контурная, но
// в tx3, а не в warn: warn зовёт человека к машине, а здесь честное «не вижу
// работы», и звать по нему было бы ложной тревогой.

export type AgentStatus = 'thinking' | 'waiting' | 'idle' | 'done'

export interface AgentRowProps {
  provider: Provider
  project: string
  status: AgentStatus
  tokens: number
  /**
   * Темп, токенов в минуту (2.3). Дописывается в ту же вторую строку, а не
   * добавляет третью: высота строки списка в попапе — 40, и лишняя строка
   * ломает ритм всего списка. Ноль или `undefined` — не показывается.
   */
  rate?: number
  /** Только для status='done': «2 мин назад». */
  endedAgo?: string
}

const STATUS_LABEL: Record<Exclude<AgentStatus, 'done'>, string> = {
  thinking: 'думает',
  waiting: 'ждёт ответа',
  idle: 'молчит',
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

const LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export function AgentRow({ provider, project, status, tokens, rate, endedAgo }: AgentRowProps) {
  const done = status === 'done'
  const accent = done ? 'var(--tx3)' : ACCENT[provider]
  // Темп мёртвого агента не показывается вовсе: «12k/мин» под «завершился»
  // читается как «всё ещё жжёт».
  const pace = done || rate === undefined || rate <= 0 ? null : ` · ${formatTokens(rate)}/мин`

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '3px 1fr',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 'var(--r-inner)',
        background: done ? 'transparent' : 'var(--s2)',
        opacity: done ? 0.55 : 1,
      }}
    >
      <div style={{ background: accent, borderRadius: 2 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontSize: 13 }}>
          {LABEL[provider]} · <span style={{ color: 'var(--tx2)' }}>{project}</span>
        </div>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--tx2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {done ? (
            <span>
              {endedAgo ? `завершился ${endedAgo}` : 'завершился'} · {formatTokens(tokens)}
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Dot status={status} />
              {STATUS_LABEL[status]} · {formatTokens(tokens)}
              {pace}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function Dot({ status }: { status: AgentStatus }) {
  if (status === 'thinking') {
    return (
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'var(--ok)',
          animation: 'am-pulse 1.6s ease-in-out infinite',
        }}
      />
    )
  }
  return (
    <span
      style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        border: `1px solid ${status === 'idle' ? 'var(--tx3)' : 'var(--warn)'}`,
        boxSizing: 'border-box',
      }}
    />
  )
}
