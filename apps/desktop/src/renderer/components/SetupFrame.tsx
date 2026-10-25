import type { ReactNode } from 'react'
import { t } from '../format.ts'
import { SETUP_STEPS, type SetupStepNumber } from '../setup.ts'

/**
 * Рама мастера первичной настройки — раздел 11 макета, строки 1813–1903.
 *
 * Шапка с логотипом, «пропустить настройку» и три полоски прогресса; подвал со
 * счётчиком шагов и парой «Назад / Далее» (на последнем шаге — «Начать»).
 *
 * Обводки, скругления и тени из макета (строка 1813) у окна нет — это окно
 * операционной системы, нарисованное дизайнером целиком, как и у главного окна.
 * Размер 640×620 задаёт main, а не рама: она занимает окно целиком.
 *
 * «Пропустить» и «Назад» — настоящие кнопки, хотя в макете это подписи: иначе
 * до них не добраться с клавиатуры. Поэтому у «пропустить» два пикселя поля —
 * браузерный отступ кнопки сброшен в ближайшее число из шапки макета.
 */
export interface SetupFrameProps {
  step: SetupStepNumber
  onSkip: () => void
  onBack: () => void
  onNext: () => void
  onStart: () => void
  children: ReactNode
}

const MONO = "'IBM Plex Mono', monospace"

export function SetupFrame({ step, onSkip, onBack, onNext, onStart, children }: SetupFrameProps) {
  const last = step === SETUP_STEPS
  return (
    <div
      data-setup-frame=""
      style={{
        width: '100%',
        // Окно целиком, а не `100%`: у `body` высоты нет, и подвал стоял бы под
        // содержимым, а не у нижнего края окна.
        height: '100vh',
        background: 'var(--bg)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          padding: '18px 22px 16px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--s1)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 13 }}>
              <div style={{ width: 3, height: 13, background: 'var(--claude)' }} />
              <div style={{ width: 3, height: 10, background: 'var(--claude)' }} />
              <div style={{ width: 3, height: 6, background: 'var(--codex)' }} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Agentmeter</span>
          </div>
          <button
            type="button"
            data-setup-action="skip"
            onClick={onSkip}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              color: 'var(--tx3)',
              background: 'transparent',
              border: 0,
              padding: 2,
              cursor: 'pointer',
            }}
          >
            {t('setup.skip')}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          {Array.from({ length: SETUP_STEPS }, (_, index) => {
            const number = index + 1
            return (
              <div
                key={number}
                data-setup-progress={number === step ? 'current' : number < step ? 'done' : 'todo'}
                style={{
                  flex: 1,
                  height: 3,
                  borderRadius: 2,
                  background: number === step ? 'var(--tx)' : number < step ? 'var(--tx3)' : 'var(--s2)',
                }}
              />
            )
          })}
        </div>
      </div>

      {children}

      <div
        style={{
          borderTop: '1px solid var(--line)',
          background: 'var(--s1)',
          padding: '14px 22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: 'var(--tx3)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {t('setup.stepOf', { n: step, total: SETUP_STEPS })}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-setup-action="back"
            disabled={step === 1}
            onClick={onBack}
            style={{
              fontSize: 12.5,
              padding: '7px 14px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: 'transparent',
              color: step === 1 ? 'var(--tx3)' : 'var(--tx)',
              cursor: step === 1 ? 'default' : 'pointer',
            }}
          >
            {t('setup.back')}
          </button>
          <button
            type="button"
            data-setup-action={last ? 'start' : 'next'}
            onClick={last ? onStart : onNext}
            style={{
              fontSize: 12.5,
              padding: '7px 16px',
              border: 0,
              borderRadius: 6,
              background: last ? 'var(--ok)' : 'var(--tx)',
              color: 'var(--bg)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {last ? t('setup.start') : t('setup.next')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Заголовок шага — строки 1832–1835: название и абзац под ним. Один на три
 * шага, поэтому здесь, рядом с рамой.
 */
export function SetupHeading({ title, lede }: { title: string; lede: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.55, textWrap: 'pretty' }}>
        {lede}
      </div>
    </div>
  )
}
