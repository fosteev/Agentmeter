import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Config } from '@agentmeter/core'
import type {
  ConfigReport,
  DayReport,
  DeepPartial,
  SpendScreen,
  HistoryScreen,
  HistorySpan,
  TaskCard,
  TodayFilter,
  TraySnapshot,
} from '@agentmeter/ipc'
// Границы дня — из ядра, тем же кодом, что у трея и CLI. Своя копия правила
// здесь стояла и была верной; опасна не она, а то, что дважды в год день
// длится 23 или 25 часов, и разойтись две копии могут ровно в этот день —
// молча, на одну сессию. Подпуть, а не барель: `query/day.ts` ни к базе, ни к
// файловой системе не ходит, а `index.ts` тянет `node:sqlite`.
import { dayRange } from '@agentmeter/core/day'
import './tokens.css'
import { SettingsTab } from './components/SettingsTab.tsx'
import { TodayTab } from './components/TodayTab.tsx'
import { BreakdownTab } from './components/BreakdownTab.tsx'
import { HistoryTab } from './components/HistoryTab.tsx'
import { TodaySide } from './components/TodaySide.tsx'
import { Window } from './components/Window.tsx'
import { WINDOW_TABS, type WindowTab } from './components/WindowTabs.tsx'
import { setLocale, t } from './format.ts'

/**
 * Тема окна.
 *
 * `system` слушает систему, `light`/`dark` ставятся сразу и подписки не
 * заводят: иначе смена системной темы перебила бы выбранную руками. Main при
 * этом двигает `nativeTheme.themeSource`, и `prefers-color-scheme` в окне
 * следует за настройкой — обе половины смотрят на одно и то же значение.
 */
function useTheme(theme: Config['ui']['theme']): void {
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
      {t('window.placeholder', { stage })}
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

/**
 * Отпечаток снимка, по которому стоит перезапросить ленту (6.1).
 *
 * Две величины: итог дня (в индекс доехали новые запросы) и живые сессии
 * вместе с их состоянием. Второе — потому что закрепление строк наверху делает
 * main при сборке, и порядок внутри закреплённых зависит от состояния: агент,
 * закончивший ход, обязан уйти под тех, кто ещё работает, как он уходит в
 * попапе. Ни одна из величин здесь не считается — обе приезжают готовыми.
 *
 * Порядок агентов в снимке в отпечаток не входит: он и так следует состоянию, а
 * учитывай мы его отдельно — лента перезапрашивалась бы на перестановке,
 * которая ничего не меняет.
 */
export function liveSignature(snapshot: TraySnapshot): string {
  const live = snapshot.agents
    .filter((agent) => agent.state !== 'done')
    .map((agent) => `${agent.sessionId}:${agent.state}`)
    .sort()
  return `${snapshot.today.total.value}|${live.join(',')}`
}

export function requestToday(
  filter: TodayFilter,
  getToday: (filter: TodayFilter) => Promise<DayReport> = window.agentmeter['today:get'],
): Promise<DayReport> {
  return getToday(filter)
}

type BreakdownArg = { scope: 'day' | 'session'; from: number; to: number }

/**
 * Развёртка за тот же период, что и лента (4.2).
 *
 * Период берётся из фильтра ленты, а не из «сегодня» по часам процесса: иначе
 * человек, переключившийся на вкладку после полуночи, увидел бы развёртку
 * другого дня — и не имел бы способа это заметить, потому что даты на экране
 * рядом нет.
 */
export function requestBreakdown(
  arg: BreakdownArg,
  getBreakdown: (arg: BreakdownArg) => Promise<SpendScreen> = window.agentmeter['breakdown:get'],
): Promise<SpendScreen> {
  return getBreakdown(arg)
}

type TaskGetter = (arg: { sessionId: string; from: number; to: number }) => Promise<TaskCard | null>

/**
 * Период уезжает вместе с идентификатором: карточка обязана показывать тот же
 * кусок задачи, что и свёрнутая строка над ней (контракт `task:get`). Берётся
 * он из фильтра ленты, а не из «сегодня» по часам процесса — иначе окно,
 * открытое до полуночи и раскрытое после, спросило бы про другой день.
 */
export function requestTask(
  sessionId: string,
  range: { from: number; to: number },
  getTask: TaskGetter = window.agentmeter['task:get'],
): Promise<TaskCard | null> {
  return getTask({ sessionId, from: range.from, to: range.to })
}

export function createTaskRequestGuard(
  getTask: TaskGetter = window.agentmeter['task:get'],
): (
  sessionId: string | null,
  range: { from: number; to: number },
) => Promise<TaskCard | null | undefined> {
  let latest = 0
  return async (sessionId, range) => {
    const request = ++latest
    if (sessionId === null) return null
    const card = await requestTask(sessionId, range, getTask)
    return request === latest ? card : undefined
  }
}

export function WindowApp() {
  const [snapshot, setSnapshot] = useState<TraySnapshot | null>(null)
  const [configReport, setConfigReport] = useState<ConfigReport | null>(null)
  const config = configReport?.config ?? null
  const [todayFilter, setTodayFilter] = useState<TodayFilter | null>(null)
  const [today, setToday] = useState<DayReport | null>(null)
  const [taskCard, setTaskCard] = useState<TaskCard | null>(null)
  const [breakdown, setBreakdown] = useState<SpendScreen | null>(null)
  const [breakdownScope, setBreakdownScope] = useState<'day' | 'session'>('day')
  const [history, setHistory] = useState<HistoryScreen | null>(null)
  const [historySpan, setHistorySpan] = useState<HistorySpan>('week')
  // Какой день раскрыт справа. `null` — выбирает main: последний день периода
  // с расходом. Хранить здесь «сегодня» нельзя — окно не знает, где кончаются
  // сутки: граница настраивается (`ui.dayStartsAtHour`).
  const [historyDay, setHistoryDay] = useState<number | null>(null)
  const [tab, setTab] = useState<WindowTab>(() =>
    initialTab(typeof location === 'undefined' ? '' : location.search),
  )
  const todayRequest = useRef(0)
  const breakdownRequest = useRef(0)
  const historyRequest = useRef(0)
  const taskRequest = useRef(createTaskRequestGuard())
  useTheme(config?.ui.theme ?? 'system')

  useEffect(() => {
    let alive = true
    void window.agentmeter['config:get']().then((report) => {
      setLocale(report.config.ui.locale)
      if (alive) setConfigReport(report)
    })
    void window.agentmeter['snapshot:get']().then((first) => {
      if (alive) setSnapshot(first)
    })
    const off = window.agentmeter['on:live:update']((next) => {
      setSnapshot(next)
    })
    // Настройки мог сменить кто угодно — соседнее окно, попап, сам main при
    // закрытии окна. Язык и тема у двух окон одного приложения обязаны быть
    // одни, поэтому окно слушает событие, а не помнит то, что отправило само.
    const offConfig = window.agentmeter['on:config:changed']((report) => {
      setLocale(report.config.ui.locale)
      setConfigReport(report)
    })
    // Ход обновления правит одно поле отчёта, а не приезжает отчётом целиком:
    // проценты скачивания идут десятками, и перерисовывать ими весь экран
    // настроек значит мигать всем, что на нём есть.
    const offUpdate = window.agentmeter['on:update:state']((update) => {
      setConfigReport((current) => (current === null ? current : { ...current, update }))
    })
    return () => {
      alive = false
      off()
      offConfig()
      offUpdate()
    }
  }, [])

  /**
   * Правка настройки: отправить и принять ответ.
   *
   * Своё состояние не правится «на опережение»: значение могло быть отвергнуто
   * загрузчиком, и показать переключённым то, что не сохранилось, — это ровно
   * тот молчаливый обман, ради которого у ответа есть список замечаний.
   */
  const changeConfig = (patch: DeepPartial<Config>): void => {
    void window.agentmeter['config:set']({ patch }).then((report) => {
      setLocale(report.config.ui.locale)
      setConfigReport(report)
    })
  }

  /**
   * Автозапуск (5.3) — свой канал и по той же причине, что у соседа выше:
   * состояние приезжает **перечитанным у системы**, а не тем, что мы просили.
   * Система вправе не разрешить, и тумблер обязан показать её ответ.
   */
  const changeStartup = (enabled: boolean): void => {
    void window.agentmeter['startup:set']({ enabled }).then(setConfigReport)
  }

  /**
   * Обновления (5.4). Ответ на «Проверить» — тот же отчёт, а ход дела приезжает
   * событием `update:state`: процентов скачивания приходят десятки, и слать с
   * каждым весь отчёт о настройках значило бы перерисовывать экран целиком ради
   * одной строки.
   */
  const checkUpdate = (): void => {
    void window.agentmeter['update:check']().then(setConfigReport)
  }
  const installUpdate = (): void => {
    void window.agentmeter['update:install']()
  }

  useEffect(() => {
    if (config === null || snapshot === null) return
    const range = dayRange(snapshot.at, config.ui.dayStartsAtHour)
    setTodayFilter((current) => {
      if (current?.from === range.from && current.to === range.to) return current
      return { ...current, ...range, sort: current?.sort ?? 'tokens' }
    })
  }, [config, snapshot])

  /**
   * Когда лента перезапрашивается (6.1).
   *
   * Кроме смены вкладки и фильтра — на два события снимка. Первое: изменился
   * итог дня, то есть в индекс доехали новые запросы, и числа в ленте устарели
   * (раньше открытое окно показывало день замороженным до смены фильтра — рядом
   * с тикающей живой строкой это стало бы заметно сразу). Второе: сменился
   * состав живых сессий, потому что закрепление строк наверху делает main при
   * сборке, и новый агент до перезапроса стоял бы на своём месте по расходу —
   * то есть в самом низу или в свёрнутом хвосте.
   *
   * Ключом, а не самим снимком: снимок приезжает раз в секунду и новым объектом
   * каждый раз, и лента перезапрашивалась бы с той же частотой.
   */
  const liveKey = snapshot === null ? '' : liveSignature(snapshot)

  // Пустая лента — только при смене периода и вкладки: там она **другая**, и
  // показывать старую под новой датой нельзя. Обновление по снимку экран не
  // гасит, иначе «Загружаем ленту…» мигало бы поверх готового списка каждый
  // раз, когда агент делает запрос.
  useEffect(() => {
    if (tab !== 'today') return
    setToday(null)
  }, [tab, todayFilter])

  useEffect(() => {
    if (todayFilter === null || tab !== 'today') return
    const request = ++todayRequest.current
    void requestToday(todayFilter).then((report) => {
      if (request === todayRequest.current) setToday(report)
    })
  }, [tab, todayFilter, liveKey])

  useEffect(() => {
    if (todayFilter === null || tab !== 'breakdown') return
    const request = ++breakdownRequest.current
    setBreakdown(null)
    void requestBreakdown({
      scope: breakdownScope,
      from: todayFilter.from,
      to: todayFilter.to,
    }).then((screen) => {
      if (request === breakdownRequest.current) setBreakdown(screen)
    })
  }, [tab, todayFilter, breakdownScope])

  useEffect(() => {
    if (tab !== 'history') return
    const request = ++historyRequest.current
    setHistory(null)
    void window.agentmeter['history:get']({
      span: historySpan,
      ...(historyDay === null ? {} : { at: historyDay }),
    }).then((screen) => {
      if (request === historyRequest.current) setHistory(screen)
    })
  }, [tab, historySpan, historyDay])

  const handleTaskToggle = (sessionId: string): void => {
    if (todayFilter === null) return
    setTaskCard(null)
    void taskRequest.current(sessionId, todayFilter).then((card) => {
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
            agents={snapshot.agents}
            onTaskToggle={handleTaskToggle}
          />
          <TodaySide report={today} onOpenBreakdown={() => setTab('breakdown')} />
        </>
      ) : tab === 'breakdown' ? (
        <BreakdownTab screen={breakdown} onScopeChange={setBreakdownScope} />
      ) : tab === 'history' ? (
        <HistoryTab
          screen={history}
          onSpanChange={(span) => {
            setHistorySpan(span)
            // Выбранный день сбрасывается вместе с периодом: он мог остаться за
            // его краем, и правая колонка показывала бы день, которого на
            // экране больше нет.
            setHistoryDay(null)
          }}
          onSelectDay={setHistoryDay}
        />
      ) : tab === 'settings' && configReport !== null ? (
        <SettingsTab
          report={configReport}
          onChange={changeConfig}
          onStartup={changeStartup}
          onCheckUpdate={checkUpdate}
          onInstallUpdate={installUpdate}
        />
      ) : (
        tabPlaceholder(tab)
      )}
    </Window>
  )
}

const root = typeof document === 'undefined' ? null : document.getElementById('root')
if (root) createRoot(root).render(<WindowApp />)
