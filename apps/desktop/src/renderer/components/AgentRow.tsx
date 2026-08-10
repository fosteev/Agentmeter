import type { Provider } from '@agentmeter/core'
import { formatTokens } from '../format.ts'
import { ProviderBadge } from './ProviderBadge.tsx'

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

// В попапе (строки 351–367) та же строка плотнее и богаче: бейдж провайдера,
// имя проекта отдельным кеглем, ветка или ключ тикета, длительность, а справа
// модель и точка входа. Это второй контекст одного компонента, а не второй
// компонент: два похожих разойдутся на первой же правке. Значения по умолчанию
// равны разделу 0, поэтому витрина и приёмка 2.4 остались нетронутыми.

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
  rate?: number | undefined
  /** Только для status='done': «2 мин назад». */
  endedAgo?: string | undefined
  /** Плотность и состав строки: раздел 0 или попап. */
  density?: 'panel' | 'popup' | undefined
  /** Ветка или ключ тикета после имени проекта: «· main», «· GARM-810». */
  branch?: string | undefined
  /** Сколько агент уже работает: «4 мин». Готовая строка, компонент не считает. */
  duration?: string | undefined
  /** Модель и точка входа справа во второй строке: «Opus 5», «VS Code». */
  model?: string | undefined
  entrypoint?: string | undefined
  /**
   * В расходе есть восстановленные запросы (1.3) — число идёт со знаком «≈»,
   * как в `agentmeter live`. Без этого попап и CLI показали бы на одной машине
   * разные числа, не сказав, какое точное.
   */
  approximate?: boolean | undefined
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

export function AgentRow(props: AgentRowProps) {
  const { provider, status, density = 'panel' } = props
  const popup = density === 'popup'
  const done = status === 'done'
  const accent = done ? 'var(--tx3)' : ACCENT[provider]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '3px 1fr',
        gap: popup ? 9 : 10,
        padding: popup ? 8 : '8px 10px',
        borderRadius: 'var(--r-inner)',
        background: done ? 'transparent' : popup ? 'var(--s1)' : 'var(--s2)',
        opacity: done ? 0.55 : 1,
      }}
    >
      <div style={{ background: accent, borderRadius: 2 }} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: popup ? 4 : 3,
          minWidth: 0,
        }}
      >
        {popup ? <PopupLines {...props} /> : <PanelLines {...props} />}
      </div>
    </div>
  )
}

function PanelLines({ provider, project, status, tokens, rate, endedAgo }: AgentRowProps) {
  const done = status === 'done'
  return (
    <>
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
            {pace(status, rate)}
          </span>
        )}
      </div>
    </>
  )
}

function PopupLines({
  provider,
  project,
  status,
  tokens,
  rate,
  endedAgo,
  branch,
  duration,
  model,
  entrypoint,
  approximate,
}: AgentRowProps) {
  const done = status === 'done'
  const amount = `${approximate ? '≈' : ''}${formatTokens(tokens)}`
  const aside = [model, entrypoint].filter(Boolean).join(' · ')
  // Второй строкой правит состояние: янтарный только у ждущего, потому что
  // именно он зовёт человека к машине. У молчащего цвет тихий — он ничего не
  // просит, мы просто не видим работы.
  const lineColor = status === 'waiting' ? 'var(--warn)' : 'var(--tx2)'

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <ProviderBadge provider={provider} />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            // Путь обрезается с хвоста, а не с начала: «pilot/flutter-pu…»
            // теряет ровно ту часть, по которой проект узнают в лицо.
            ...(project.includes('/')
              ? { direction: 'rtl' as const, textAlign: 'left' as const }
              : {}),
          }}
        >
          {project}
        </span>
        {branch ? (
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              color: 'var(--tx3)',
              whiteSpace: 'nowrap',
            }}
          >
            · {branch}
          </span>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: done ? 'var(--tx2)' : lineColor,
            fontVariantNumeric: 'tabular-nums',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            minWidth: 0,
          }}
        >
          {done ? null : <Dot status={status} />}
          <span style={{ whiteSpace: 'nowrap' }}>
            {done
              ? `${endedAgo ? `завершился ${endedAgo}` : 'завершился'} · ${amount}`
              : `${duration ? `${duration} · ` : ''}${amount}${status === 'thinking' ? '' : ` · ${STATUS_LABEL[status]}`}${pace(status, rate) ?? ''}`}
          </span>
        </div>
        {aside ? (
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10,
              color: 'var(--tx3)',
              whiteSpace: 'nowrap',
              flex: 'none',
            }}
          >
            {aside}
          </span>
        ) : null}
      </div>
    </>
  )
}

// Темп мёртвого агента не показывается вовсе: «12k/мин» под «завершился»
// читается как «всё ещё жжёт».
function pace(status: AgentStatus, rate: number | undefined): string | null {
  if (status === 'done' || rate === undefined || rate <= 0) return null
  return ` · ${formatTokens(rate)}/мин`
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
          flex: 'none',
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
        flex: 'none',
      }}
    />
  )
}
