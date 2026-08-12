/// <reference types="vite/client" />

import { useState, type CSSProperties, type ReactNode } from 'react'
import type { Provider, TaskRow as TaskRowData } from '@agentmeter/core'
import type {
  DayReport,
  TaskCard as TaskCardData,
  TodayFilter,
  TraySnapshot,
} from '@agentmeter/ipc'
import emptyRaw from '../../../../fixtures/popup/empty.json?raw'
import errorRaw from '../../../../fixtures/popup/error.json?raw'
import indexingRaw from '../../../../fixtures/popup/indexing.json?raw'
import nobodyRaw from '../../../../fixtures/popup/nobody.json?raw'
import snapshotRaw from '../../../../fixtures/popup/snapshot.json?raw'
import todayRaw from '../../../../fixtures/window/today.json?raw'
import taskRaw from '../../../../fixtures/window/task.json?raw'
import './tokens.css'
import { AgentRow } from './components/AgentRow.tsx'
import { Popup } from './components/Popup.tsx'
import { LimitBar } from './components/LimitBar.tsx'
import { TaskRow } from './components/TaskRow.tsx'
import { BreakdownRow } from './components/BreakdownRow.tsx'
import { Window } from './components/Window.tsx'
import { WINDOW_TABS, type WindowTab } from './components/WindowTabs.tsx'
import { TodayTab } from './components/TodayTab.tsx'
import { TodaySide } from './components/TodaySide.tsx'
import { TaskCard } from './components/TaskCard.tsx'

// Витрина раздела 0: токены, четыре компонента во всех состояниях и обеих
// темах. Это приёмочный лист — Electron-окно и бандлер поднимаются в 2.5,
// здесь только разметка. Показывает тёмную тему как основную, светлую рядом.

const MONO = "'IBM Plex Mono', monospace"

function Card({
  title,
  width,
  children,
  note,
}: {
  title: string
  width: number
  children: ReactNode
  note?: string
}) {
  return (
    <div
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 20,
        width,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      {children}
      {note ? (
        <div
          style={{ fontFamily: MONO, fontSize: 10, color: 'var(--tx3)', letterSpacing: '.06em' }}
        >
          {note}
        </div>
      ) : null}
    </div>
  )
}

function Swatch({ varName }: { varName: string }) {
  return (
    <div
      style={{
        height: 44,
        borderRadius: 6,
        background: `var(${varName})`,
        border: varName === '--tx2' || varName === '--tx' ? 'none' : '1px solid var(--line)',
      }}
    />
  )
}

function PaletteCard() {
  return (
    <Card title="Палитра" width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          <Swatch varName="--bg" />
          <Swatch varName="--s1" />
          <Swatch varName="--s2" />
          <Swatch varName="--tx2" />
          <Swatch varName="--tx" />
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 8,
            fontFamily: MONO,
            fontSize: 9,
            color: 'var(--tx3)',
          }}
        >
          <div>bg</div>
          <div>surface</div>
          <div>raise</div>
          <div>text-2</div>
          <div>text-1</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          <Swatch varName="--claude" />
          <Swatch varName="--codex" />
          <Swatch varName="--ok" />
          <Swatch varName="--warn" />
          <Swatch varName="--alarm" />
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 8,
            fontFamily: MONO,
            fontSize: 9,
            color: 'var(--tx3)',
          }}
        >
          <div>Claude</div>
          <div>Codex</div>
          <div>норма</div>
          <div>близко</div>
          <div>предел</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
        Всего два «фирменных» цвета — по одному на агента. Остальные три работают только как шкала
        тревоги на полосах лимитов.
      </div>
    </Card>
  )
}

function TypeRow({ text, spec, style }: { text: string; spec: string; style: CSSProperties }) {
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}
    >
      <span style={style}>{text}</span>
      <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--tx3)' }}>{spec}</span>
    </div>
  )
}

function TypographyCard() {
  return (
    <Card title="Шкала типографики" width={360}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <TypeRow text="Заголовок окна" spec="20/600" style={{ fontSize: 20, fontWeight: 600 }} />
        <TypeRow text="Название задачи" spec="15/600" style={{ fontSize: 15, fontWeight: 600 }} />
        <TypeRow text="Основной текст строки" spec="13/400" style={{ fontSize: 13 }} />
        <TypeRow
          text="Метаданные, второй уровень"
          spec="12/400"
          style={{ fontSize: 12, color: 'var(--tx2)' }}
        />
        <TypeRow
          text="Заголовок секции"
          spec="11/mono"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        />
        <TypeRow
          text="344.9M · 68% · 12:04"
          spec="числа"
          style={{ fontFamily: MONO, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
        />
      </div>
      <div
        style={{
          borderTop: '1px solid var(--line)',
          paddingTop: 12,
          fontSize: 12,
          color: 'var(--tx2)',
          lineHeight: 1.5,
        }}
      >
        IBM Plex Sans для слов, IBM Plex Mono с tabular-nums для всех чисел, времени и процентов.
      </div>
    </Card>
  )
}

function GridCard() {
  const rows: Array<[number, string]> = [
    [4, 'внутри строки'],
    [8, 'между строками'],
    [12, 'поля попапа'],
    [20, 'между блоками'],
    [32, 'поля окна'],
  ]
  return (
    <Card title="Сетка отступов" width={260}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(([w, label]) => (
          <div key={w} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ height: 10, width: w, background: 'var(--codex)', borderRadius: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--tx2)' }}>
              {w} — {label}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--line)',
          paddingTop: 12,
          fontSize: 12,
          color: 'var(--tx2)',
          lineHeight: 1.5,
        }}
      >
        Строка списка — 44 px в окне, 40 px в попапе. Радиус: 6 внутри, 10 у карточек.
      </div>
    </Card>
  )
}

function Badge({ children, color }: { children: string; color: string }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--bg)',
        background: color,
        borderRadius: 3,
        padding: '2px 5px',
      }}
    >
      {children}
    </div>
  )
}

function DistinctionsCard() {
  return (
    <Card title="Два различия, сквозные по всему приложению" width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          Агент
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge color="var(--claude)">CL</Badge>
            <span style={{ fontSize: 12, color: 'var(--tx2)' }}>Claude · янтарный</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge color="var(--codex)">CX</Badge>
            <span style={{ fontSize: 12, color: 'var(--tx2)' }}>Codex · холодный</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          Точность данных
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 120,
              height: 8,
              borderRadius: 4,
              background: 'var(--s2)',
              overflow: 'hidden',
            }}
          >
            <div style={{ width: '62%', height: '100%', background: 'var(--ok)' }} />
          </div>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              width: 44,
            }}
          >
            62%
          </span>
          <span style={{ fontSize: 12, color: 'var(--tx2)' }}>точно — сплошная заливка</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 120,
              height: 8,
              borderRadius: 4,
              background: 'var(--s2)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: '62%',
                height: '100%',
                background:
                  'repeating-linear-gradient(115deg, var(--warn) 0 3px, color-mix(in oklch, var(--warn) 32%, transparent) 3px 7px)',
              }}
            />
          </div>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              width: 44,
              color: 'var(--tx2)',
            }}
          >
            ≈62%
          </span>
          <span style={{ fontSize: 12, color: 'var(--tx2)' }}>оценка — штриховка и «≈»</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
        Никаких подписей-дисклеймеров: штриховка и знак «≈» перед числом достаточно однозначны и не
        занимают места.
      </div>
    </Card>
  )
}

function taskRow(provider: Provider, title: string, total: number): TaskRowData {
  return {
    sessionId: 'demo',
    provider,
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    project: 'demo',
    branch: null,
    ticket: null,
    model: 'demo',
    title: title.length === 0 ? null : title,
    firstPrompt: null,
    totals: {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      total,
      requests: 0,
    },
    toolCalls: 0,
    agentType: null,
    children: [],
    approximate: false,
    sidechain: false,
  }
}

function ComponentCards() {
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Card
        title="Строка агента — состояния"
        width={420}
        note="думает (пульс) · ждёт (контур) · молчит (контур tx3) · завершён (гашение)"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <AgentRow
            provider="claude"
            project="ollama-bar"
            status="thinking"
            tokens={38_000}
            rate={12_400}
          />
          <AgentRow provider="claude" project="pilot" status="waiting" tokens={214_000} />
          {/* Состояния макетом не нарисовано — добавлено в 2.2, см. AgentRow. */}
          <AgentRow provider="codex" project="troy" status="idle" tokens={51_000} />
          <AgentRow
            provider="codex"
            project="troy"
            status="done"
            tokens={12_000}
            endedAgo="2 мин назад"
          />
        </div>
      </Card>

      <Card
        title="Полоса лимита — состояния"
        width={360}
        note="норма <60 · близко 60–85 · предел >85"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          <LimitBar percent={5} approximate={false} />
          <LimitBar percent={68} approximate={true} />
          <LimitBar percent={94} approximate={false} forecast="≈40 мин до упора" />
          <LimitBar percent={100} approximate={false} selected={true} />
        </div>
      </Card>

      <Card title="Строка задачи и элемент развёртки" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <TaskRow task={taskRow('claude', 'обычная', 30_300_000)} />
          <TaskRow task={taskRow('claude', 'наведение', 30_300_000)} hover={true} />
          <TaskRow task={taskRow('claude', 'раскрыта', 30_300_000)} expanded={true} />
          <TaskRow task={taskRow('codex', '', 62_100_000)} />
        </div>
        <div
          style={{
            borderTop: '1px solid var(--line)',
            marginTop: 4,
            paddingTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <BreakdownRow
            label="Bash"
            tokens={24_000}
            max={33_333}
            persistent={false}
            accent="codex"
          />
          <BreakdownRow label="MCP: jira" tokens={14_800} max={33_333} persistent={true} />
          <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--tx3)' }}>
            сплошная = разовый расход · штриховка = постоянный, платится каждую сессию
          </div>
        </div>
      </Card>
    </div>
  )
}

function ThemeBlock({ theme }: { theme: 'dark' | 'light' }) {
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    padding: 20,
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--bg)',
  }
  return (
    <div style={style} data-theme={theme === 'light' ? 'light' : 'dark'}>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '.14em',
          textTransform: 'uppercase',
          color: 'var(--tx3)',
        }}
      >
        {theme === 'dark' ? 'Тёмная тема · основная' : 'Светлая тема · дневной свет'}
      </div>
      <ComponentCards />
    </div>
  )
}

const POPUPS: Array<{ title: string; snapshot: TraySnapshot }> = [
  { title: 'Обычный попап', snapshot: JSON.parse(snapshotRaw) as TraySnapshot },
  { title: 'Агенты ещё не запускались', snapshot: JSON.parse(emptyRaw) as TraySnapshot },
  { title: 'Первичное индексирование', snapshot: JSON.parse(indexingRaw) as TraySnapshot },
  { title: 'Ошибка чтения', snapshot: JSON.parse(errorRaw) as TraySnapshot },
  { title: 'Нет активных агентов', snapshot: JSON.parse(nobodyRaw) as TraySnapshot },
]

const WINDOW_SNAPSHOT = JSON.parse(snapshotRaw) as TraySnapshot
const TODAY_REPORT = JSON.parse(todayRaw) as DayReport
const TASK_CARD = JSON.parse(taskRaw) as TaskCardData

function PopupCards() {
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {POPUPS.map(({ title, snapshot }) => (
        <div
          key={title}
          style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
          <Popup snapshot={snapshot} now={snapshot.at + 2000} />
        </div>
      ))}
    </div>
  )
}

function WindowCard() {
  const [tab, setTab] = useState<WindowTab>('today')
  const [filter, setFilter] = useState<TodayFilter>({
    ...TODAY_REPORT.range,
    sort: 'tokens',
  })
  const stage = WINDOW_TABS.find((item) => item.id === tab)!.stage

  return (
    // Рамка и скругление — здесь, а не в компоненте: в макете это рамка окна
    // операционной системы (строка 603), и в настоящем окне её рисует она сама.
    <div
      style={{
        width: 1180,
        height: 740,
        border: '1px solid var(--line)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <Window snapshot={WINDOW_SNAPSHOT} activeTab={tab} onTabChange={setTab}>
        {tab === 'today' ? (
          <>
            <TodayTab report={TODAY_REPORT} filter={filter} onFilterChange={setFilter} />
            <TodaySide report={TODAY_REPORT} />
          </>
        ) : (
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
        )}
      </Window>
    </div>
  )
}

export function Gallery() {
  return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Agentmeter · Основа системы — витрина
        </div>
        <div style={{ fontSize: 13, color: 'var(--tx2)', lineHeight: 1.55, maxWidth: 760 }}>
          Перенос строк 49–208 макета в код: палитра, типографика, сетка, четыре компонента. Ниже —
          те же компоненты в тёмной и светлой темах. Числа моноширинные, цвет кодирует только смысл.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <PaletteCard />
        <TypographyCard />
        <GridCard />
        <DistinctionsCard />
      </div>

      <ThemeBlock theme="dark" />
      <ThemeBlock theme="light" />

      <div
        data-theme="dark"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          padding: 20,
          border: '1px solid var(--line)',
          borderRadius: 12,
          background: 'var(--bg)',
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          Попап · обычный и четыре состояния
        </div>
        <PopupCards />
      </div>

      <div
        data-theme="dark"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          padding: 20,
          border: '1px solid var(--line)',
          borderRadius: 12,
          background: 'var(--bg)',
          overflow: 'auto',
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          Главное окно · лента «Сегодня»
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          <WindowCard />
          <div style={{ width: 900, flex: 'none' }}>
            <TaskCard card={TASK_CARD} />
          </div>
        </div>
      </div>
    </div>
  )
}
