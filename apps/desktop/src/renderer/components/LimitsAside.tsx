import type { LimitReportRow } from '@agentmeter/core'
import type { LimitsSource } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { ago, span } from '../time.ts'

/**
 * Правая часть заголовка «Лимиты» в попапе (6.3).
 *
 * До этого этапа там стояло зашитое «≈ оценка» — и это было верно ровно
 * потому, что проценты Claude всегда были нашим расчётом. Теперь их может
 * сказать провайдер, и тогда слово «оценка» становится враньём наоборот:
 * приуменьшением точности. Поэтому подпись считается по самим окнам — есть ли
 * среди показанных хоть одно неточное, — а не по настройке и не по наличию
 * ответа.
 *
 * Кнопка появляется только при включённом источнике. Выключенный он не
 * рекламируется здесь ни словом: место для разговора о том, включать ли
 * сетевой вызов, — экран настроек, где рядом написано, что именно уйдёт
 * наружу. Кнопка в попапе, включающая сеть одним нажатием, была бы ровно тем
 * согласием по умолчанию, которого этап избегает.
 */
export interface LimitsAsideProps {
  limits: readonly LimitReportRow[]
  source: LimitsSource
  now: number
  onAsk?: (() => void) | undefined
}

export function LimitsAside({ limits, source, now, onAsk }: LimitsAsideProps) {
  const estimated = limits.some((window) => !window.exact)
  const waiting = source.retryAt !== undefined && source.retryAt > now

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={NOTE} data-limits-note="">
        {estimated ? t('popup.estimate') : null}
      </span>
      {source.enabled ? (
        <>
          <span style={NOTE} data-limits-asked="">
            {waiting
              ? t('popup.limitsWaiting', { in: span(source.retryAt! - now) })
              : source.askedAt === undefined
                ? t('popup.limitsNever')
                : t('popup.limitsAsked', { ago: ago(Math.max(0, now - source.askedAt)) })}
          </span>
          <button
            type="button"
            data-limits-action="ask"
            onClick={onAsk}
            disabled={waiting}
            aria-label={t('popup.limitsAsk')}
            title={t('popup.limitsAsk')}
            style={{
              ...NOTE,
              border: '1px solid var(--line)',
              borderRadius: 5,
              background: 'transparent',
              padding: '4px',
              lineHeight: '10px',
              color: waiting ? 'var(--tx3)' : 'var(--tx2)',
              cursor: waiting ? 'default' : 'pointer',
            }}
          >
            ⟳
          </button>
        </>
      ) : null}
    </span>
  )
}

const NOTE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10,
  color: 'var(--tx3)',
} as const
