import type { LimitReportRow, Provider } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { ago, span } from '../time.ts'
import { PopupFooter } from './PopupFooter.tsx'
import { PopupHeader } from './PopupHeader.tsx'
import { PopupLimit } from './PopupLimit.tsx'
import { SectionTitle } from './SectionTitle.tsx'

// «Никого нет» — строки 1237–1252 макета. История берётся только из
// `lastAgent`: хранить её ещё и в окне значило бы получить два разных
// «последних» после перезапуска рендерера.

export interface PopupIdleProps {
  snapshot: TraySnapshot
  now: number
  onOpenWindow?: (() => void) | undefined
}

const PROVIDER: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

/** Ключи, а не слова: длина названия окна проверяется потолком (3.8). */
const KIND_KEY = {
  fiveHour: 'limit.fiveHour',
  weekly: 'limit.weekly',
  monthly: 'limit.monthly',
  other: 'limit.other',
} as const satisfies Record<LimitReportRow['kind'], string>

function caption(window: LimitReportRow, at: number): string {
  if (window.usedPercent === null) return window.unavailableReason ?? t('limit.unknownPercent')
  return t('limit.idleWindow', { span: span(Math.max(0, window.resetsAt - at)) })
}

/**
 * Метка выделенного куска внутри переведённой фразы.
 *
 * Фраза «Никого. Последний — Codex · troy, 18 мин назад» переводится **целиком**
 * и одним ключом, хотя середина в макете выделена цветом. Разрежь её на «до» и
 * «после» двумя ключами — и порядок слов задавала бы разметка, а не язык.
 * Служебный символ в тексте каталога не встречается, поэтому разрез однозначен.
 */
const MARK = '\u0000'

export function PopupIdle({ snapshot, now, onOpenWindow }: PopupIdleProps) {
  const { at, lastAgent, limits, today } = snapshot
  if (lastAgent === undefined) return null

  const [beforeAgent = '', afterAgent = ''] = t('popup.idleLast', {
    agent: MARK,
    ago: ago(at - lastAgent.endedAt),
  }).split(MARK)

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

      <SectionTitle title={t('popup.working')} padding="14px 14px 6px" />
      <div style={{ padding: '0 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
        <div
          aria-hidden="true"
          style={{
            width: 3,
            height: 22,
            background: 'var(--tx3)',
            borderRadius: 2,
            opacity: 0.5,
          }}
        />
        <div style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
          {beforeAgent}
          <span style={{ color: 'var(--tx)' }}>
            {PROVIDER[lastAgent.provider]} · {lastAgent.project}
          </span>
          {afterAgent}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: '16px 14px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          gap: 10,
        }}
      >
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

      <PopupFooter
        total={`${today.total.confidence === 'exact' ? '' : '≈'}${formatTokens(today.total.value)}`}
        summary={`${t('today.sessions', { count: today.sessions })} · ${t('today.projectsPlain', { count: today.projects })}`}
        onOpenWindow={onOpenWindow}
      />
    </div>
  )
}
