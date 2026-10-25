import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConfigReport, IndexProgress, SetupFinish, SetupScan } from '@agentmeter/ipc'
import './tokens.css'
import { SetupWizard } from './components/SetupWizard.tsx'
import { setLocale } from './format.ts'
import { shouldRescan } from './setup.ts'

/**
 * Окно первичной настройки (7.3): страница `setup.html`.
 *
 * Наружу из этой страницы идёт **один** вызов, меняющий состояние, —
 * `setup:finish`. Остальное — чтение: настройки, найденное на диске и ход
 * индексации. Каналов `config:set`, `startup:set` и `oauth:set` здесь нет и быть
 * не должно (тест держит это по исходнику): запись «по щелчку» значила бы, что
 * «Пропустить» уже не оставляет конфиг как был.
 *
 * Проход индекса к этому моменту идёт — main поднимает мастер после его старта,
 * поэтому окно не ждёт прохода, а наблюдает за ним.
 */
export function SetupApp() {
  const [report, setReport] = useState<ConfigReport | null>(null)
  const [scan, setScan] = useState<SetupScan | null>(null)
  const [snapshotKnown, setSnapshotKnown] = useState(false)
  const [indexing, setIndexing] = useState<IndexProgress | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Предыдущий ход и время последнего обхода — для `shouldRescan`; в состоянии
  // им не место: перерисовки от них не нужны.
  const seen = useRef<{ indexing: IndexProgress | undefined; scanAt: number }>({
    indexing: undefined,
    scanAt: 0,
  })

  useEffect(() => {
    let alive = true
    const rescan = (): void => {
      seen.current.scanAt = Date.now()
      void window.agentmeter['setup:scan']().then((next) => {
        if (alive) setScan(next)
      })
    }
    const observe = (next: IndexProgress | undefined): void => {
      const before = seen.current.indexing
      seen.current.indexing = next
      setIndexing(next)
      setSnapshotKnown(true)
      if (shouldRescan(before, next, Date.now() - seen.current.scanAt)) rescan()
    }

    void window.agentmeter['config:get']().then((first) => {
      setLocale(first.config.ui.locale)
      if (alive) setReport(first)
    })
    rescan()
    void window.agentmeter['snapshot:get']().then((first) => {
      if (alive) observe(first.indexing)
    })
    const offLive = window.agentmeter['on:live:update']((next) => {
      observe(next.indexing)
    })
    const offProgress = window.agentmeter['on:index:progress']((next) => {
      observe(next)
    })
    return () => {
      alive = false
      offLive()
      offProgress()
    }
  }, [])

  if (report === null) return null

  const finish = (arg: SetupFinish): void => {
    if (busy) return
    setBusy(true)
    // Окно закроет main; если запись не удалась, кнопки снова живые.
    void window.agentmeter['setup:finish'](arg).catch(() => {
      setBusy(false)
    })
  }

  return (
    <SetupWizard
      report={report}
      scan={scan}
      snapshotKnown={snapshotKnown}
      indexing={indexing}
      onFinish={finish}
    />
  )
}

const root = typeof document === 'undefined' ? null : document.getElementById('root')
if (root) createRoot(root).render(<SetupApp />)
