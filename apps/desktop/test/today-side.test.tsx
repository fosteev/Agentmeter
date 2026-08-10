import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DayReport, HourBucket, ProjectRow, TicketRow } from '@agentmeter/ipc'
import { HourChart } from '../src/renderer/components/HourChart.tsx'
import { ProjectBars } from '../src/renderer/components/ProjectBars.tsx'
import { TodaySide } from '../src/renderer/components/TodaySide.tsx'
import { formatTokens, setLocale } from '../src/renderer/format.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

function fixture(name: 'today' | 'today-empty' | 'today-filtered'): DayReport {
  return JSON.parse(readFileSync(`${root}fixtures/window/${name}.json`, 'utf8')) as DayReport
}

const today = fixture('today')
const emptyDay = fixture('today-empty')
const filtered = fixture('today-filtered')
setLocale('ru')

function hourMarkup(hours: HourBucket[]): string {
  return renderToStaticMarkup(<HourChart hours={hours} />)
}

function projectMarkup(projects: ProjectRow[]): string {
  return renderToStaticMarkup(<ProjectBars projects={projects} />)
}

function hour(markup: string, value: number): string {
  const start = markup.indexOf(`data-hour="${value}"`)
  const next = markup.indexOf('data-hour=', start + 1)
  return markup.slice(start, next === -1 ? undefined : next)
}

function project(markup: string, index: number): string {
  const start = markup.indexOf(`data-project-row="${index}"`)
  const next = markup.indexOf('data-project-row=', start + 1)
  return markup.slice(start, next === -1 ? undefined : next)
}

function hourSliceHeight(markup: string, hourValue: number, provider: string): number {
  const match = hour(markup, hourValue).match(
    new RegExp(`data-hour-slice="${provider}" style="background:[^;]+;height:([^%]+)%`),
  )
  return Number(match?.[1])
}

function projectFillWidth(markup: string, index: number): number {
  const match = project(markup, index).match(
    new RegExp(`data-project-fill="${index}" style="width:([^%]+)%`),
  )
  return Number(match?.[1])
}

describe('правая колонка вкладки «Сегодня»', () => {
  /**
   * Ловит столбик, сведённый к первому куску, и куски, нормированные по итогу
   * собственного часа вместо максимума всей диаграммы.
   */
  it('рисует оба куска составного часа относительно общего максимума', () => {
    const bucket = today.byHour.find(({ hour: value }) => value === 13)!
    const maximum = Math.max(...today.byHour.map(({ total }) => total))
    const html = hourMarkup(today.byHour)
    const bucketHtml = hour(html, bucket.hour)

    expect(bucketHtml.split('data-hour-slice=').length - 1).toBe(2)
    for (const slice of bucket.slices) {
      expect(bucketHtml).toContain(`background:var(--${slice.provider})`)
      expect(hourSliceHeight(html, bucket.hour, slice.provider)).toBeCloseTo(
        (slice.tokens / maximum) * 100,
        8,
      )
    }
  })

  /** Ловит знаменатель, равный сумме всех часов вместо самого дорогого часа. */
  it('делает самый дорогой час стопроцентным', () => {
    expect(hourSliceHeight(hourMarkup(today.byHour), 9, 'claude')).toBe(100)
  })

  /** Ловит byHour[0].total, взятый вместо максимума по всем часам. */
  it('ищет максимум часов не только в первой строке', () => {
    const hours: HourBucket[] = [
      { hour: 9, slices: [{ provider: 'claude', tokens: 10 }], total: 10 },
      { hour: 10, slices: [{ provider: 'codex', tokens: 100 }], total: 100 },
    ]
    const html = hourMarkup(hours)

    expect(hourSliceHeight(html, 9, 'claude')).toBe(10)
    expect(hourSliceHeight(html, 10, 'codex')).toBe(100)
  })

  /** Ловит повторный подсчёт total сложением slices в окне. */
  it('берёт максимум из готового total, даже когда куски с ним не сходятся', () => {
    const hours: HourBucket[] = [
      { hour: 9, slices: [{ provider: 'claude', tokens: 10 }], total: 100 },
      { hour: 10, slices: [{ provider: 'codex', tokens: 50 }], total: 50 },
    ]
    const html = hourMarkup(hours)

    expect(hourSliceHeight(html, 9, 'claude')).toBe(10)
    expect(hourSliceHeight(html, 10, 'codex')).toBe(50)
  })

  /** Ловит сжатую временную ось, на которой соседствуют несоседние часы. */
  it('оставляет пустой столбик на месте пропущенного часа', () => {
    const withoutTwelve = today.byHour.filter(({ hour: value }) => value !== 12)
    const html = hourMarkup(withoutTwelve)
    const first = withoutTwelve[0]!.hour
    const last = withoutTwelve.at(-1)!.hour

    expect(html.split('data-hour=').length - 1).toBe(last - first + 1)
    expect(hour(html, 12)).not.toContain('data-hour-slice=')
  })

  /** Ловит ось не из непрерывного ряда, без средней метки или ведущего нуля. */
  it('подписывает первый, средний и последний часы ряда', () => {
    const labels = [...hourMarkup(today.byHour).matchAll(/<span>(\d\d)<\/span>/g)].map(
      ([, label]) => label,
    )
    expect(labels).toEqual(['09', '13', '17'])
  })

  /** Ловит повторную сортировку проектов, потерю формата числа и провайдера. */
  it('рисует проекты в порядке фикстуры с готовыми значениями и цветами', () => {
    const html = projectMarkup(today.byProject)

    expect(html.split('data-project-row=').length - 1).toBe(5)
    today.byProject.forEach((row, index) => {
      const name = row.folded === undefined ? row.project : `+ ${row.folded} проекта`
      expect(project(html, index)).toContain(`>${name}<`)
    })
    expect(project(html, 0)).toContain(`≈${formatTokens(156_200_000)}`)
    expect(projectFillWidth(html, 0)).toBe(100)
    expect(project(html, 2)).toContain('background:var(--codex)')
  })

  /** Ловит byProject[0], взятый вместо максимума по всем строкам, включая хвост. */
  it('нормирует проекты по настоящему максимуму, даже если максимум в хвосте', () => {
    const projects: ProjectRow[] = [
      {
        project: 'named',
        tokens: { value: 50, confidence: 'exact' },
        provider: 'claude',
      },
      {
        project: '',
        tokens: { value: 100, confidence: 'exact' },
        provider: null,
        folded: 2,
      },
    ]
    const html = projectMarkup(projects)

    expect(projectFillWidth(html, 0)).toBe(50)
    expect(projectFillWidth(html, 1)).toBe(100)
  })

  /** Ловит хвост с пустым именем, ручным склонением и цветом провайдера. */
  it('собирает и красит хвост по folded, а не по имени', () => {
    const tailIndex = today.byProject.findIndex(({ folded }) => folded !== undefined)
    const html = projectMarkup(today.byProject)
    const tail = project(html, tailIndex)
    const oneProject = projectMarkup([
      { ...today.byProject[tailIndex]!, project: 'не использовать', folded: 1 },
    ])

    expect(tail).toContain('>+ 4 проекта<')
    expect(tail).toContain('font-size:12px;color:var(--tx2)')
    expect(tail).toContain('background:var(--tx3)')
    expect(tail).toContain('text-align:right;color:var(--tx2)')
    expect(oneProject).toContain('>+ 1 проект<')
    expect(oneProject).not.toContain('не использовать')
  })

  /** Ловит потерянную либо безусловную пометку оценочного расхода. */
  it('помечает только оценочные проекты знаком, штриховкой и причиной', () => {
    const approximateIndex = today.byProject.findIndex(({ project: name }) => name === 'ollama-bar')
    const exactIndex = today.byProject.findIndex(({ project: name }) => name === 'pilot')
    const html = projectMarkup(today.byProject)
    const approximate = project(html, approximateIndex)
    const exact = project(html, exactIndex)
    const caveat = today.byProject[approximateIndex]!.tokens.caveat!

    expect(approximate).toContain(`title="${caveat}"`)
    expect(approximate).toContain(
      `≈${formatTokens(today.byProject[approximateIndex]!.tokens.value)}`,
    )
    expect(approximate).toContain('repeating-linear-gradient')
    expect(exact).not.toContain('>≈')
    expect(exact).not.toContain('repeating-linear-gradient')
    expect(exact).not.toContain('title=')
  })

  /** Ловит NaN и разделитель или блок, оставшийся без данных. */
  it('оставляет колонку пустой на пустом дне и пустом фильтре', () => {
    for (const report of [emptyDay, filtered]) {
      const html = renderToStaticMarkup(<TodaySide report={report} />)
      expect(html).not.toContain('data-today-side-block=')
      expect(html).not.toContain('data-today-side-divider=')
      expect(html).not.toContain('NaN')
    }
  })

  /** Ловит диаграмму, нарисованную поверх ещё не прочитанного индекса. */
  it('оставляет колонку пустой при emptyIndex', () => {
    const html = renderToStaticMarkup(<TodaySide report={{ ...today, emptyIndex: true }} />)
    expect(html).not.toContain('data-today-side-block=')
    expect(html).not.toContain('data-today-side-divider=')
    expect(html).not.toContain('Расход по часам')
    expect(html).not.toContain('По проектам')
    // Полоса разложения — четвёртый блок колонки, и своего `data-today-side-block`
    // у неё нет: без отдельной строки она рисовалась бы поверх непрочитанного
    // индекса, а две проверки выше этого не заметили бы.
    expect(html).not.toContain('data-spend-split')
  })

  /**
   * Ловит блок тикетов, нарисованный пустым (3.7): за большинство дней ветки
   * ключа не несут, и заголовок «По тикетам» над пустотой обещал бы разрез,
   * которого нет. Ловит и подпись хвоста, взятую у проектов: «+ 2 проекта» в
   * списке тикетов — это чужое слово над своими числами.
   */
  it('блок тикетов появляется только при тикетах и считает свой хвост своими словами', () => {
    const withoutTickets = renderToStaticMarkup(<TodaySide report={today} />)
    expect(withoutTickets).not.toContain('data-today-side-block="tickets"')
    expect(withoutTickets).not.toContain('По тикетам')

    const tickets: TicketRow[] = [
      { ticket: 'GARM-664', tokens: { value: 4_000_000, confidence: 'exact' }, provider: 'claude' },
      { ticket: 'SC-248', tokens: { value: 1_000_000, confidence: 'exact' }, provider: 'codex' },
      { ticket: 'GARM-573', tokens: { value: 900_000, confidence: 'exact' }, provider: 'claude' },
      { ticket: 'GARM-625', tokens: { value: 800_000, confidence: 'exact' }, provider: 'claude' },
      { ticket: '', tokens: { value: 300_000, confidence: 'exact' }, provider: null, folded: 2 },
    ]
    const html = renderToStaticMarkup(<TodaySide report={{ ...today, byTicket: tickets }} />)

    expect(html).toContain('data-today-side-block="tickets"')
    expect(html).toContain('По тикетам')
    expect(html).toContain('GARM-664')
    expect(html).toContain('+ 2 тикета')
    expect(html).not.toContain('+ 2 проекта')
  })

  /**
   * Ловит полосу, посчитанную окном от токенов заново (4.1).
   *
   * Доля приезжает готовой, потому что её видно числом; посчитай окно ширину
   * из `tokens.value`, и подпись «41%» встала бы над полосой другой длины —
   * два ответа на один вопрос, оба похожие на правду.
   */
  it('полоса разложения берёт ширину из готовой доли, а не из токенов', () => {
    const html = renderToStaticMarkup(<TodaySide report={today} />)
    const share = today.split!.slices

    expect(html).toContain('data-spend-split')
    expect(html).toContain(`data-spend-fill="recurring" style="width:${share[0]!.share * 100}%`)
    expect(html).toContain(`data-spend-fill="marginal" style="width:${share[1]!.share * 100}%`)
    expect(html).toContain(`${formatTokens(141_400_000)} · 41%`)
    expect(html).toContain(`${formatTokens(203_500_000)} · 59%`)
    expect(html).toContain(today.split!.note!)
  })

  /**
   * Ловит потерянную пометку оценки. Внутри обеих долей лежат восстановленные
   * запросы (1.3), и доля от неточного целого точной быть не может: без знака
   * `≈` два восстановленных числа выглядели бы измеренными.
   */
  it('обе доли помечены оценкой, раз итог дня восстановлен', () => {
    const html = renderToStaticMarkup(<TodaySide report={today} />)

    expect(html).toContain(`≈${formatTokens(141_400_000)}`)
    expect(html).toContain(`≈${formatTokens(203_500_000)}`)
    expect(html).toContain('разрыву цепочки кэша')
  })

  /**
   * Ловит блок, нарисованный нулями. «На префикс ушло ноль» — это утверждение,
   * и оно ложное там, где верно «за период ничего не считали»: поля просто нет,
   * как у тикетов.
   */
  it('блока разложения нет, когда поля нет', () => {
    const withoutSplit: DayReport = { ...today }
    delete withoutSplit.split
    const html = renderToStaticMarkup(<TodaySide report={withoutSplit} />)

    expect(html).not.toContain('data-spend-split')
    expect(html).not.toContain('Куда ушло сегодня')
  })
})

/**
 * Ловит ссылку «Развёртка →», нарисованную без обработчика: переход на вкладку,
 * которую никто не откроет, — обещание, а не навигация, и нажмут его один раз.
 * Проверяются оба конца: с обработчиком ссылка есть, без него её нет вовсе.
 */
it('ссылка на развёртку появляется только вместе с переходом', () => {
  const withLink = renderToStaticMarkup(
    <TodaySide report={today as DayReport} onOpenBreakdown={() => undefined} />,
  )
  const without = renderToStaticMarkup(<TodaySide report={today as DayReport} />)

  expect(withLink).toContain('data-spend-link')
  expect(withLink).toContain('Развёртка')
  expect(without).not.toContain('data-spend-link')
})
