import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Config } from '@agentmeter/core'
import type { DayReport, TaskCard, TodayFilter, TraySnapshot } from '@agentmeter/ipc'
// Границы дня — из ядра, тем же кодом, что у трея и CLI. Своя копия правила
// здесь стояла и была верной; опасна не она, а то, что дважды в год день
// длится 23 или 25 часов, и разойтись две копии могут ровно в этот день —
// молча, на одну сессию. Подпуть, а не барель: `query/day.ts` ни к базе, ни к
// файловой системе не ходит, а `index.ts` тянет `node:sqlite`.
import { dayRange } from '@agentmeter/core/day'
import './tokens.css'
import { TodayTab } from './components/TodayTab.tsx'
import { TodaySide } from './components/TodaySide.tsx'
import { Window } from './components/Window.tsx'
import { WINDOW_TABS, type WindowTab } from './components/WindowTabs.tsx'
import { setLocale } from './format.ts'

function useTheme(): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => {
      media.removeEventListener('change', apply)
    }
  }, [])
}

export function tabPlaceholder(tab: WindowTab): ReactElement {
  const stage = WINDOW_TABS.find((item) => item.id === tab)!.stage
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--tx3)',
        fontSize: 13,
      }}
    >
      этот экран появится в {stage}
    </div>
  )
}

/**
 * На какой вкладке открылось окно.
 *
 * Вкладку выбирает тот, кто окно поднял: попап зовёт `window:open` с `today` из
 * подвала и с `settings` с экрана ошибки. Едет она параметром адреса, потому что
 * в момент создания окна канала, по которому её можно спросить, ещё нет.
 * Незнакомое значение — не повод падать: показываем ленту.
 */
export function initialTab(search: string): WindowTab {
  const value = new URLSearchParams(search).get('tab')
  return WINDOW_TABS.some((item) => item.id === value) ? (value as WindowTab) : 'today'
}

export function requestToday(
  filter: TodayFilter,
  getToday: (filter: TodayFilter) => Promise<DayReport> = window.agentmeter['today:get'],
): Promise<DayReport> {
  return getToday(filter)
}

type TaskGetter = (arg: { sessionId: string }) => Promise<TaskCard | null>

export function requestTask(
  sessionId: string,
  getTask: TaskGetter = window.agentmeter['task:get'],
): Promise<TaskCard | null> {
  return getTask({ sessionId })
}

export function createTaskRequestGuard(
  getTask: TaskGetter = window.agentmeter['task:get'],
): (sessionId: string | null) => Promise<TaskCard | null | undefined> {
  let latest = 0
  return async (sessionId) => {
    const request = ++latest
    if (sessionId === null) return null
    const card = await requestTask(sessionId, getTask)
    return request === latest ? card : undefined
  }
}

export function WindowApp() {
  const [snapshot, setSnapshot] = useState<TraySnapshot | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [todayFilter, setTodayFilter] = useState<TodayFilter | null>(null)
  const [today, setToday] = useState<DayReport | null>(null)
  const [taskCard, setTaskCard] = useState<TaskCard | null>(null)
  const [tab, setTab] = useState<WindowTab>(() =>
    initialTab(typeof location === 'undefined' ? '' : location.search),
  )
  const todayRequest = useRef(0)
  const taskRequest = useRef(createTaskRequestGuard())
  useTheme()

  useEffect(() => {
    let alive = true
    void window.agentmeter['config:get']().then(({ config }) => {
      setLocale((config as Config).ui.locale)
      if (alive) setConfig(config as Config)
    })
    void window.agentmeter['snapshot:get']().then((first) => {
      if (alive) setSnapshot(first)
    })
    const off = window.agentmeter['on:live:update']((next) => {
      setSnapshot(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (config === null || snapshot === null) return
    const range = dayRange(snapshot.at, config.ui.dayStartsAtHour)
    setTodayFilter((current) => {
      if (current?.from === range.from && current.to === range.to) return current
      return { ...current, ...range, sort: current?.sort ?? 'tokens' }
    })
  }, [config, snapshot])

  useEffect(() => {
    if (todayFilter === null || tab !== 'today') return
    const request = ++todayRequest.current
    setToday(null)
    void requestToday(todayFilter).then((report) => {
      if (request === todayRequest.current) setToday(report)
    })
  }, [tab, todayFilter])

  const handleTaskToggle = (sessionId: string): void => {
    setTaskCard(null)
    void taskRequest.current(sessionId).then((card) => {
      if (card !== undefined) setTaskCard(card)
    })
  }

  if (snapshot === null || config === null) return null
  return (
    <Window snapshot={snapshot} activeTab={tab} onTabChange={setTab}>
      {tab === 'today' && todayFilter !== null ? (
        <>
          <TodayTab
            report={today}
            filter={todayFilter}
            onFilterChange={setTodayFilter}
            taskCard={taskCard}
            onTaskToggle={handleTaskToggle}
          />
          <TodaySide report={today} />
        </>
      ) : (
        tabPlaceholder(tab)
      )}
    </Window>
  )
}

const root = typeof document === 'undefined' ? null : document.getElementById('root')
if (root) createRoot(root).render(<WindowApp />)
