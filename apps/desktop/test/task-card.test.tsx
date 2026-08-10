import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DayReport, TaskCard as TaskCardData, TimelinePoint } from '@agentmeter/ipc'
import { TaskCard } from '../src/renderer/components/TaskCard.tsx'
import { TaskRows, toggleTask } from '../src/renderer/components/TaskTable.tsx'
import { TaskTimeline } from '../src/renderer/components/TaskTimeline.tsx'
import { clock, formatTokens, setLocale } from '../src/renderer/format.ts'
import { createTaskRequestGuard } from '../src/renderer/window-main.tsx'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const card = JSON.parse(readFileSync(`${root}fixtures/window/task.json`, 'utf8')) as TaskCardData
const today = JSON.parse(readFileSync(`${root}fixtures/window/today.json`, 'utf8')) as DayReport
setLocale('ru')

function markup(value: TaskCardData = card): string {
  return renderToStaticMarkup(<TaskCard card={value} />)
}

function segment(html: string, attribute: string, value: string | number): string {
  const marker = `${attribute}="${value}"`
  const start = html.indexOf(marker)
  const next = html.indexOf(`${attribute}=`, start + marker.length)
  return html.slice(start, next === -1 ? undefined : next)
}

function percent(
  html: string,
  attribute: string,
  value: string | number,
  property: string,
): number {
  const match = segment(html, attribute, value).match(new RegExp(`${property}:([^%]+)%`))
  return Number(match?.[1])
}

function tool(html: string, label: string): string {
  return segment(html, 'data-breakdown-row', label)
}

describe('карточка задачи', () => {
  /** Ловит прореживание запросов и нормирование всех высот до общей суммы. */
  it('рисует все точки таймлайна без подгонки суммы высот', () => {
    const html = markup()
    const heights = card.timeline.map((_, index) =>
      percent(html, 'data-timeline-point', index, 'height'),
    )

    expect(html.split('data-timeline-point=').length - 1).toBe(card.timeline.length)
    expect(card.timeline).toHaveLength(276)
    expect(heights.reduce((sum, height) => sum + height, 0)).toBeGreaterThan(100)
  })

  /** Ловит знаменатель, равный сумме токенов задачи вместо максимальной точки. */
  it('делает самую дорогую точку стопроцентной, а соседнюю рядовую — ниже', () => {
    const maximum = Math.max(...card.timeline.map(({ tokens }) => tokens))
    const maximumIndex = card.timeline.findIndex(({ tokens }) => tokens === maximum)
    const neighbour = [maximumIndex - 1, maximumIndex + 1].find(
      (index) => card.timeline[index]?.note === undefined,
    )!
    const html = markup()

    expect(percent(html, 'data-timeline-point', maximumIndex, 'height')).toBe(100)
    expect(percent(html, 'data-timeline-point', neighbour, 'height')).toBeLessThan(90)
  })

  /** Ловит timeline[0].tokens, взятый вместо максимума по всему таймлайну. */
  it('ищет максимум таймлайна не только в первой точке', () => {
    const timeline: TimelinePoint[] = [
      { ts: card.task.startedAt, tokens: 10 },
      { ts: card.task.endedAt, tokens: 100 },
    ]
    const html = renderToStaticMarkup(<TaskTimeline timeline={timeline} provider="claude" />)

    expect(percent(html, 'data-timeline-point', 0, 'height')).toBe(10)
    expect(percent(html, 'data-timeline-point', 1, 'height')).toBe(100)
  })

  /** Ловит выделение без причины и покраску alarm всех точек подряд. */
  it('красит и объясняет только две точки с note', () => {
    const html = markup()
    const highlighted = card.timeline
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => point.note !== undefined)
    const regular = card.timeline.findIndex(({ note }) => note === undefined)

    expect(highlighted).toHaveLength(2)
    for (const { point, index } of highlighted) {
      const pointHtml = segment(html, 'data-timeline-point', index)
      expect(pointHtml).toContain('title=')
      expect(pointHtml).toContain(point.note!)
      expect(pointHtml).toContain('background:var(--alarm)')
    }
    const regularHtml = segment(html, 'data-timeline-point', regular)
    expect(regularHtml).toContain('background:var(--claude)')
    expect(regularHtml).not.toContain('title=')
  })

  /** Ловит собранную окном фразу и потерянные крайние времена. */
  it('подписывает таймлайн готовой заметкой между первым и последним временем', () => {
    const html = segment(markup(), 'data-timeline-caption', '')

    expect(html).toContain(clock(card.timeline[0]!.ts))
    expect(html).toContain(clock(card.timeline.at(-1)!.ts))
    expect(html).toContain(card.timelineNote!)
    expect(html).toContain('color:var(--alarm)')
  })

  /** Ловит пересчёт долей из токенов и перестановку видов токенов. */
  it('показывает четыре приехавших вида, доли и числа в контрактном порядке', () => {
    const html = markup()
    const order = [...html.matchAll(/data-token-slice="([^"]+)"/g)].map(([, kind]) => kind)

    expect(order).toEqual(['input', 'cacheWrite', 'cacheRead', 'output'])
    card.tokens.forEach((slice) => {
      expect(percent(html, 'data-token-slice', slice.kind, 'width')).toBeCloseTo(
        slice.share * 100,
        8,
      )
      const legend = segment(html, 'data-token-legend', slice.kind)
      expect(legend).toContain(formatTokens(slice.tokens.value))
      expect(legend).toContain(`${Math.round(slice.share * 100)}%`)
    })
    expect(card.tokens.map(({ share }) => Math.round(share * 100))).toEqual([7, 11, 76, 6])
  })

  /** Ловит цветовой литерал, скопированный из макета для записи в кэш. */
  it('выражает цвет записи в кэш через переменную Claude', () => {
    const cacheWrite = segment(markup(), 'data-token-slice', 'cacheWrite')

    expect(cacheWrite).toContain('var(--claude)')
    expect(cacheWrite).not.toContain('oklch(0.755')
  })

  /** Ловит tools[0], взятый вместо максимума по всем инструментам. */
  it('ищет максимум инструментов не только в первой строке', () => {
    const rows = [
      { ...card.tools[0]!, marginal: { ...card.tools[0]!.marginal, value: 10 } },
      { ...card.tools[1]!, marginal: { ...card.tools[1]!.marginal, value: 100 } },
    ]
    const html = markup({ ...card, tools: rows })

    expect(percent(html, 'data-breakdown-row', rows[0]!.label, 'width')).toBe(10)
    expect(percent(html, 'data-breakdown-row', rows[1]!.label, 'width')).toBe(100)
  })

  /** Ловит потерянную либо безусловную пометку оценки инструмента. */
  it('штрихует и помечает знаком только оценочный Read', () => {
    const html = markup()
    const read = tool(html, 'Read')
    const bash = tool(html, 'Bash')

    expect(read).toContain('repeating-linear-gradient')
    expect(read).toContain(`≈${formatTokens(19_300)}`)
    expect(read).toContain(card.tools[1]!.marginal.caveat!)
    expect(bash).not.toContain('repeating-linear-gradient')
    expect(bash).not.toContain('>≈')
    expect(bash).not.toContain('title=')
  })

  /** Ловит выделение инструмента, потерянное вместе с его причиной. */
  it('красит alarm и объясняет только Screenshot', () => {
    const html = markup()
    const screenshot = tool(html, 'Screenshot')

    expect(screenshot).toContain('background:var(--alarm)')
    expect(screenshot).toContain('color:var(--alarm)')
    expect(screenshot).toContain(card.tools[2]!.note!)
    for (const label of ['Bash', 'Read', 'Edit', 'Grep']) {
      expect(tool(html, label)).not.toContain('title="картинки')
    }
  })

  /** Ловит колонку calls, потерянную при переносе инструментов в карточку. */
  it('показывает число вызовов рядом с именем инструмента', () => {
    const html = markup()

    expect(tool(html, 'Bash')).toMatch(/>Bash<span[^>]*> 93<\/span>/)
    expect(tool(html, 'Read')).toMatch(/>Read<span[^>]*> 20<\/span>/)
  })

  /** Ловит хвост файлов, посчитанный не как total минус число путей. */
  it('показывает total файлов, четыре пути и хвост плюс восемь', () => {
    const html = markup()

    expect(html).toContain('Затронутые файлы · 12')
    expect(html.split('data-file-chip="path"').length - 1).toBe(4)
    expect(html.split('data-file-chip=').length - 1).toBe(5)
    expect(segment(html, 'data-file-chip', 'tail')).toContain('+ 8')
  })

  /** Ловит пустые блоки и NaN при отсутствии необязательных полей контракта. */
  it('собирается без необязательных файлов и заметок', () => {
    const minimal = structuredClone(card)
    delete minimal.files
    delete minimal.note
    delete minimal.timelineNote
    const html = markup(minimal)

    expect(html).not.toContain('data-task-files=')
    expect(html).not.toContain('data-token-note=')
    expect(html).not.toContain('Затронутые файлы')
    expect(html).not.toContain('NaN')
  })

  /** Ловит пересчитанную долю дня и потерянные ветку, расход или мета-строку. */
  it('показывает название, мета-строку, расход и готовую долю дня', () => {
    const html = markup()
    const meta = segment(html, 'data-task-card-meta', '')

    expect(html).toContain(card.task.title!)
    expect(meta).toContain('Claude · Opus 5')
    expect(meta).toContain('Projects · main')
    expect(meta).toContain(`${clock(card.task.startedAt)} → ${clock(card.task.endedAt)}`)
    expect(meta).toContain('41 мин')
    expect(meta).toContain('276 запросов')
    expect(html).toContain(formatTokens(card.task.tokens.value))
    expect(html).toContain('25% дневного расхода')
  })

  /** Ловит раскрытие по индексу, потерянный повторный collapse и карточку поверх строки. */
  it('переключает строку по sessionId и рисует карточку сразу под ней', () => {
    const onToggle = vi.fn<(sessionId: string) => void>()
    const first = today.tasks[0]!
    const second = today.tasks[1]!
    let expanded = toggleTask(null, first.sessionId, onToggle)

    expect(expanded).toBe(first.sessionId)
    expect(onToggle).toHaveBeenLastCalledWith(first.sessionId)
    const html = renderToStaticMarkup(
      <TaskRows
        tasks={[first, second]}
        maxTokens={first.tokens.value}
        expandedSessionId={expanded}
        taskCard={card}
        onToggle={() => undefined}
      />,
    )
    expect(html.indexOf(`data-task-entry="${first.sessionId}"`)).toBeLessThan(
      html.indexOf(`data-task-card="${first.sessionId}"`),
    )
    expect(html.indexOf(`data-task-card="${first.sessionId}"`)).toBeLessThan(
      html.indexOf(`data-task-entry="${second.sessionId}"`),
    )

    expanded = toggleTask(expanded, first.sessionId, onToggle)
    expect(expanded).toBeNull()
    expect(onToggle).toHaveBeenCalledOnce()
  })

  /** Ловит ответ предыдущего task:get, показанный после переключения на новую строку. */
  it('отбрасывает запоздавший ответ прошлой задачи', async () => {
    let resolveFirst!: (value: TaskCardData | null) => void
    let resolveSecond!: (value: TaskCardData | null) => void
    const firstResponse = new Promise<TaskCardData | null>((resolve) => (resolveFirst = resolve))
    const secondResponse = new Promise<TaskCardData | null>((resolve) => (resolveSecond = resolve))
    const getTask = vi
      .fn<(arg: { sessionId: string; from: number; to: number }) => Promise<TaskCardData | null>>()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse)
    const guarded = createTaskRequestGuard(getTask)
    const firstId = today.tasks[0]!.sessionId
    const secondId = today.tasks[1]!.sessionId
    const range = { from: today.range.from, to: today.range.to }
    const first = guarded(firstId, range)
    const second = guarded(secondId, range)
    const secondCard = { ...card, task: { ...card.task, sessionId: secondId } }

    resolveSecond(secondCard)
    await expect(second).resolves.toBe(secondCard)
    resolveFirst(card)
    await expect(first).resolves.toBeUndefined()
    expect(getTask).toHaveBeenNthCalledWith(1, { sessionId: firstId, ...range })
    expect(getTask).toHaveBeenNthCalledWith(2, { sessionId: secondId, ...range })
  })

  /**
   * Ловит карточку, спрошенную без периода ленты.
   *
   * Задача, начатая до полуночи, попадает в оба дня своими кусками. Спроси
   * карточку без периода — и под строкой на 40M раскроется карточка на 87M,
   * причём оба числа настоящие. На живых логах это 32 сессии из 578 и 21.5%
   * расхода.
   */
  it('спрашивает карточку тем же периодом, что и лента', async () => {
    const getTask = vi.fn<
      (arg: { sessionId: string; from: number; to: number }) => Promise<TaskCardData | null>
    >(() => Promise.resolve(card))
    const range = { from: today.range.from, to: today.range.to }
    await createTaskRequestGuard(getTask)(card.task.sessionId, range)

    expect(getTask).toHaveBeenCalledWith({ sessionId: card.task.sessionId, ...range })
  })
})
