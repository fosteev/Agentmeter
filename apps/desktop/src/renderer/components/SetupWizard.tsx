import { useEffect, useReducer } from 'react'
import type { Config } from '@agentmeter/core'
import type { ConfigReport, IndexProgress, SetupFinish, SetupScan } from '@agentmeter/ipc'
import {
  finishArg,
  initialSetupState,
  setupReducer,
  skipArg,
  type SetupDraft,
} from '../setup.ts'
import { SetupFrame } from './SetupFrame.tsx'
import { SetupStepBehavior } from './SetupStepBehavior.tsx'
import { SetupStepSources } from './SetupStepSources.tsx'
import { SetupStepThresholds } from './SetupStepThresholds.tsx'

/**
 * Мастер первичной настройки целиком: рама и три шага (раздел 11 макета,
 * строки 1813–1903).
 *
 * **Наружу уходит один вызов — `onFinish`.** Пока человек листает шаги, он
 * правит только черновик в памяти окна; конфиг не меняется, и «Пропустить» на
 * любом шаге оставляет его как был. Тема в черновике примеряется на самом окне
 * (это его же собственный `data-theme`), но не пишется никуда.
 */
export interface SetupWizardProps {
  report: ConfigReport
  scan: SetupScan | null
  snapshotKnown: boolean
  indexing: IndexProgress | undefined
  onFinish: (arg: SetupFinish) => void
}

/** Тема окна. Копия правила из `main.tsx`/`window-main.tsx`: `system` слушает систему. */
function usePreviewTheme(theme: Config['ui']['theme']): void {
  useEffect(() => {
    if (theme !== 'system') {
      document.documentElement.dataset.theme = theme
      return
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => {
      media.removeEventListener('change', apply)
    }
  }, [theme])
}

export function SetupWizard({ report, scan, snapshotKnown, indexing, onFinish }: SetupWizardProps) {
  const [state, dispatch] = useReducer(setupReducer, report, initialSetupState)
  usePreviewTheme(state.draft.theme)
  const onDraft = (patch: Partial<SetupDraft>): void => {
    dispatch({ type: 'draft', patch })
  }

  return (
    <SetupFrame
      step={state.step}
      onSkip={() => onFinish(skipArg())}
      onBack={() => dispatch({ type: 'back' })}
      onNext={() => dispatch({ type: 'next' })}
      onStart={() => onFinish(finishArg(state.draft, report))}
    >
      {state.step === 1 ? <SetupStepSources scan={scan} /> : null}
      {state.step === 2 ? <SetupStepThresholds draft={state.draft} onDraft={onDraft} /> : null}
      {state.step === 3 ? (
        <SetupStepBehavior
          draft={state.draft}
          onDraft={onDraft}
          startup={report.startup}
          updatesSupported={report.update.phase !== 'unsupported'}
          scan={scan}
          snapshotKnown={snapshotKnown}
          indexing={indexing}
        />
      ) : null}
    </SetupFrame>
  )
}
