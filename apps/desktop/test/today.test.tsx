import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DayReport, TodayFilter } from '@agentmeter/ipc'
import { TaskTable } from '../src/renderer/components/TaskTable.tsx'
import { TodayFilters } from '../src/renderer/components/TodayFilters.tsx'
import { TodayTab } from '../src/renderer/components/TodayTab.tsx'
import { formatTokens, setLocale } from '../src/renderer/format.ts'
import { requestToday } from '../src/renderer/window-main.tsx'

const root = fileURLToPath(new URL('../../../', import.meta.url))

function fixture(name: 'today' | 'today-empty' | 'today-filtered'): DayReport {
  return JSON.parse(readFileSync(`${root}fixtures/window/${name}.json`, 'utf8')) as DayReport
}

const today = fixture('today')
const emptyDay = fixture('today-empty')
const filtered = fixture('today-filtered')
const filter: TodayFilter = { ...today.range, sort: 'tokens' }
setLocale('ru')

function tabMarkup(report: DayReport): string {
  return renderToStaticMarkup(
    <TodayTab report={report} filter={filter} onFilterChange={() => undefined} />,
  )
}

interface InteractiveProps {
  children?: ReactNode
  onClick?: () => void
  onChange?: (event: { currentTarget: { value: string } }) => void
  value?: string
}

function findElements(
  node: ReactNode,
  type: 'button' | 'select',
): Array<ReactElement<InteractiveProps>> {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<InteractiveProps>
  const own = element.type === type ? [element] : []
  return [
    ...own,
    ...Children.toArray(element.props.children).flatMap((child) => findElements(child, type)),
  ]
}

function row(markup: string, sessionId: string): string {
  const start = markup.indexOf(`data-task-id="${sessionId}"`)
  const next = markup.indexOf('data-task-id=', start + 1)
  return markup.slice(start, next === -1 ? undefined : next)
}

function fillWidth(markup: string, sessionId: string): number {
  const match = markup.match(new RegExp(`data-token-fill="${sessionId}" style="width:([^%]+)%`))
  return Number(match?.[1])
}

describe('лента «Сегодня» на контрактных фикстурах', () => {
  /** Ловит показ строк из готового хвоста и подпись с вшитыми 8/4M из макета. */
  it('рисует только строки до folded.from и собирает хвост из приехавших чисел', () => {
    const report: DayReport = {
      ...today,
      folded: { from: 14, belowTokens: 4_600_000 },
    }
    expect(report.tasks.length - report.folded!.from).toBe(8)
    expect(report.tasks[report.folded!.from]).toBeDefined()

    const html = tabMarkup(report)
    expect(html.split('data-task-id=').length - 1).toBe(report.folded!.from)
    expect(html).not.toContain(report.tasks[report.folded!.from]!.sessionId)
    expect(html).toContain(
      `и ещё 8 задач ниже ${formatTokens(report.folded!.belowTokens)} — свернуто`,
    )
  })

  /** Ловит самовольную свёртку «первых восьми», когда main прислал folded: null. */
  it('без folded рисует все строки и не показывает подпись хвоста', () => {
    const report: DayReport = { ...today, folded: null }
    expect(report.tasks.length).toBeGreaterThan(8)

    const html = renderToStaticMarkup(<TaskTable tasks={report.tasks} folded={report.folded} />)
    expect(html.split('data-task-id=').length - 1).toBe(report.tasks.length)
    expect(html).not.toContain('— свернуто')
  })

  /**
   * Ловит безымянную строку, ставшую обычной, потерянный ≈/штриховку и полосу,
   * ширина которой не соответствует расходу конкретной задачи.
   */
  it('различает виды и точность строк, ширину полосы привязывает к задаче', () => {
    const namedExact = today.tasks.find(
      (task) => task.title !== null && task.tokens.confidence === 'exact',
    )!
    const namedRestored = today.tasks.find(
      (task) => task.title !== null && task.tokens.confidence === 'reconstructed',
    )!
    const untitled = today.tasks.find(
      (task) => task.title === null && task.firstPrompt !== undefined,
    )!
    expect(namedExact.tokens.value).not.toBe(namedRestored.tokens.value)
    expect(untitled.firstPrompt).toBeTruthy()

    const html = renderToStaticMarkup(<TaskTable tasks={today.tasks} folded={today.folded} />)
    const exactHtml = row(html, namedExact.sessionId)
    const restoredHtml = row(html, namedRestored.sessionId)
    const untitledHtml = row(html, untitled.sessionId)
    const maximum = Math.max(...today.tasks.map((task) => task.tokens.value))

    expect(exactHtml).toContain(`>${formatTokens(namedExact.tokens.value)}<`)
    expect(exactHtml).not.toContain(`>≈${formatTokens(namedExact.tokens.value)}<`)
    expect(restoredHtml).toContain(`>≈${formatTokens(namedRestored.tokens.value)}<`)
    expect(restoredHtml).toContain('repeating-linear-gradient')
    expect(untitledHtml).toContain('Без названия')
    expect(untitledHtml).toContain(`первый промпт: «${untitled.firstPrompt}»`)
    expect(untitledHtml).not.toContain(untitled.model!)
    expect(fillWidth(html, namedExact.sessionId)).toBeCloseTo(
      (namedExact.tokens.value / maximum) * 100,
      8,
    )
    expect(fillWidth(html, namedRestored.sessionId)).toBeCloseTo(
      (namedRestored.tokens.value / maximum) * 100,
      8,
    )
  })

  /**
   * Ловит строку задачи, промолчавшую про сабагентов (3.5).
   *
   * Свёрнутая строка показывает расход всего дерева, и без упоминания детей
   * задача с четырьмя сабагентами выглядит просто дорогой — объяснения к числу
   * на экране нет. Проверяется и обратное: задача без детей второй подписи не
   * получает, иначе «0 сабагентов» будет у каждой строки ленты.
   */
  it('строка называет число сабагентов и молчит, когда их нет', () => {
    const [parent, ...rest] = today.tasks
    const children = [
      { ...rest[0]!, sessionId: 'agent-a1', agentType: 'Explore' },
      { ...rest[1]!, sessionId: 'agent-a2', agentType: 'Plan' },
    ]
    const tasks = [{ ...parent!, children }, ...rest]

    const html = renderToStaticMarkup(<TaskTable tasks={tasks} folded={null} />)

    expect(row(html, parent!.sessionId)).toContain('2 сабагента')
    expect(row(html, rest[0]!.sessionId)).not.toContain('сабагент')
  })

  /**
   * Ловит подмену ветки ключом (3.7): `GARM-664.zigbee` и `GARM-664.ui` —
   * разная работа по одному тикету, и оставь строка один ключ, две задачи
   * стали бы неразличимыми. Ключ при этом обязан быть виден отдельно.
   */
  it('строка показывает ветку целиком, а ключ тикета выделен внутри неё', () => {
    const [task, ...rest] = today.tasks
    const tagged = { ...task!, branch: 'GARM-664.zigbee', ticket: 'GARM-664' }

    const html = renderToStaticMarkup(<TaskTable tasks={[tagged, ...rest]} folded={null} />)
    const line = row(html, tagged.sessionId)

    expect(line).toContain('data-ticket="GARM-664"')
    expect(line).toContain('.zigbee')
    // Строка без ключа выделять нечего — и она этого не делает.
    expect(row(html, rest[0]!.sessionId)).not.toContain('data-ticket')
  })

  /**
   * Ловит колонку «Запросы», в которую попали вызовы инструментов.
   *
   * Это разные величины — 276 запросов к API при 195 вызовах инструментов, — и
   * поле `requests` заведено в контракте ровно под эту колонку. Подмена тихая:
   * число похоже на правду и стоит в правильном месте.
   */
  it('в колонке запросов стоят запросы, а не вызовы инструментов', () => {
    const task = today.tasks.find((value) => value.requests !== value.toolCalls)!
    expect(task, 'на входе нет задачи, где эти числа различаются').toBeDefined()

    const html = row(
      renderToStaticMarkup(<TaskTable tasks={today.tasks} folded={today.folded} />),
      task.sessionId,
    )
    expect(html).toContain(`>${task.requests}<`)
    expect(html).not.toContain(`>${task.toolCalls}<`)
  })

  /**
   * Ловит шапку дня, нарисованную поверх непрочитанного индекса.
   *
   * Пока логи не разобраны, итога нет — есть незнание, и «0 сессий · 0 токенов»
   * было бы утверждением, причём ложным: файлы на диске лежат. У пустого дня
   * нули настоящие, и там шапка обязана остаться.
   */
  it('на непрочитанном индексе итога дня нет, на пустом дне — есть', () => {
    const indexing: DayReport = { ...emptyDay, emptyIndex: true }
    expect(tabMarkup(indexing)).not.toContain('токенов')
    expect(tabMarkup(emptyDay)).toContain('токенов')
  })

  /** Ловит фильтр/сортировку, которые меняют только локальный массив без today:get. */
  it('смена провайдера и сортировки отправляет новый полный TodayFilter в today:get', async () => {
    let next = filter
    const controls = TodayFilters({ filter, onChange: (value) => (next = value) })
    const codex = findElements(controls, 'button').find(
      (button) => button.props.children === 'Codex',
    )!
    codex.props.onClick?.()
    const sort = findElements(
      TodayFilters({ filter: next, onChange: (value) => (next = value) }),
      'select',
    )[0]!
    sort.props.onChange?.({ currentTarget: { value: 'started' } })

    const getToday = vi.fn(async () => filtered)
    const result = await requestToday(next, getToday)
    expect(getToday).toHaveBeenCalledOnce()
    expect(getToday).toHaveBeenCalledWith({ ...filter, provider: 'codex', sort: 'started' })
    expect(result).toBe(filtered)
  })

  /** Ловит emptyIndex, emptyDay и отсечённый фильтр, сведённые к одному «пусто». */
  it('показывает три разных пустых экрана по трём разным входам', () => {
    const indexing: DayReport = { ...emptyDay, emptyIndex: true }
    expect(indexing.emptyIndex).toBe(true)
    expect(emptyDay.emptyDay).toBe(true)
    expect(filtered.emptyIndex || filtered.emptyDay || filtered.tasks.length !== 0).toBe(false)

    const screens = [tabMarkup(indexing), tabMarkup(emptyDay), tabMarkup(filtered)]
    expect(screens[0]).toContain('Первичное индексирование')
    expect(screens[1]).toContain('Сегодня задач не было')
    expect(screens[2]).toContain('По выбранному фильтру задач нет')
    expect(new Set(screens).size).toBe(3)
  })

  /** Ловит итог, повторно сложенный в окне из четырёх видов токенов. */
  it('показывает totals.total как есть, даже когда он не равен сумме соседних полей', () => {
    const report: DayReport = {
      ...today,
      totals: {
        ...today.totals,
        total: { value: 12_345_678, confidence: 'exact' },
      },
    }
    const parts =
      report.totals.input.value +
      report.totals.output.value +
      report.totals.cacheWrite.value +
      report.totals.cacheRead.value
    expect(parts).not.toBe(report.totals.total.value)

    const html = tabMarkup(report)
    expect(html).toContain(`>${formatTokens(report.totals.total.value)}<`)
    expect(html).not.toContain(`>${formatTokens(parts)}<`)
  })
})
