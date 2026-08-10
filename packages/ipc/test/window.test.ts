import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DayReport, Measured, TaskCard, TaskRow } from '../src/index.ts'

/**
 * Фикстуры главного окна (M3) обязаны быть ровно тем, что описывает контракт.
 *
 * Тест не про вёрстку — про вход, на котором вёрстку вообще можно проверить.
 * Файл разбирается приведением, а приведение молчит и о лишних полях, и о
 * недостающих. Плюс вторая половина, которой в 2.5 не было: фикстура обязана
 * **содержать** случаи, ради которых сделана. Проверка на входе, где нужного
 * случая нет, зелена на любом коде.
 */
function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/window/${name}.json`, import.meta.url)),
      'utf8',
    ),
  ) as T
}

const day = fixture<DayReport>('today')
const emptyDay = fixture<DayReport>('today-empty')
const filtered = fixture<DayReport>('today-filtered')
const card = fixture<TaskCard>('task')

const DAY_KEYS = [
  'range',
  'emptyIndex',
  'emptyDay',
  'totals',
  'tasks',
  'folded',
  'byHour',
  'byProject',
  'split',
]
const TASK_KEYS = [
  'sessionId',
  'title',
  'firstPrompt',
  'project',
  'branch',
  'provider',
  'model',
  'startedAt',
  'endedAt',
  'requests',
  'toolCalls',
  'tokens',
  'children',
]
const CARD_KEYS = [
  'task',
  'dayShare',
  'timeline',
  'timelineNote',
  'tokens',
  'tools',
  'note',
  'files',
]

const RANK = { exact: 0, reconstructed: 1, estimate: 2 } as const
const worst = (values: readonly Measured[]): Measured =>
  values.reduce((left, right) => (RANK[left.confidence] >= RANK[right.confidence] ? left : right))

describe('fixtures/window — контракт 0.4 под M3', () => {
  /**
   * Ловит фикстуру, отставшую от контракта: окно собирается по типу, а данные
   * тестов — по этим файлам, и разойтись они могут молча. Лишнее поле здесь —
   * это экран, собранный по данным, которых main не отдаёт.
   */
  it('поля отчёта и строки задачи — только те, что в контракте', () => {
    for (const [name, report] of Object.entries({ day, emptyDay, filtered })) {
      expect(
        Object.keys(report).filter((key) => !DAY_KEYS.includes(key)),
        name,
      ).toEqual([])
      for (const key of DAY_KEYS.slice(0, -1)) {
        expect(key in report, `${name}: нет ${key}`).toBe(true)
      }
    }
    for (const task of day.tasks) {
      expect(Object.keys(task).filter((key) => !TASK_KEYS.includes(key))).toEqual([])
    }
    expect(Object.keys(card).filter((key) => !CARD_KEYS.includes(key))).toEqual([])
  })

  /**
   * Ловит ленту, на которой свёртку хвоста нечем проверить: список не по
   * расходу, граница стоит не там или хвоста нет вовсе.
   *
   * Свёртка — единственная арифметика, которую окно делает над лентой, и
   * ошибиться в ней можно тихо: спрятать строку дороже порога либо оставить
   * видимой строку дешевле. И то и другое выглядит как нормальный список.
   */
  it('лента отсортирована по расходу вниз, а хвост свёрнут ровно по порогу', () => {
    const values = day.tasks.map((task) => task.tokens.value)
    expect(values).toEqual([...values].sort((left, right) => right - left))

    const folded = day.folded
    expect(folded, 'без свёртки проверять нечего').not.toBeNull()
    expect(day.tasks.length - folded!.from).toBeGreaterThanOrEqual(2)
    expect(folded!.from).toBeGreaterThan(0)
    for (const [index, value] of values.entries()) {
      // Видимая часть — всё, что не дешевле порога; хвост — всё, что дешевле.
      expect(value >= folded!.belowTokens, `строка ${index}`).toBe(index < folded!.from)
    }
  })

  /**
   * Ловит фикстуру, на которой окно нельзя собрать без счёта в нём самом.
   *
   * Итог обязан сходиться и с суммой задач, и с четырьмя видами токенов.
   * Разойдись он — и тест ленты закрепит расхождение как норму: в шапке одно
   * число, в списке другое, и объяснить это будет нечем.
   */
  it('итог дня сходится с задачами и с четырьмя видами, точность — худшая из них', () => {
    const { input, output, cacheWrite, cacheRead, total } = day.totals
    expect(total.value).toBe(input.value + output.value + cacheWrite.value + cacheRead.value)
    expect(day.tasks.reduce((sum, task) => sum + task.tokens.value, 0)).toBe(total.value)
    expect(day.totals.requests).toBe(day.tasks.reduce((sum, task) => sum + task.requests, 0))

    const source = worst([input, output, cacheWrite, cacheRead])
    expect(total.confidence).toBe(source.confidence)
    expect(total.caveat).toBe(source.caveat)
  })

  /**
   * Ловит вход, на котором «≈» проверять нечем: точность в ленте различается
   * по строкам, и если все они точные, любая реализация пройдёт.
   */
  it('в ленте есть и точные строки, и восстановленные — с причиной', () => {
    expect(day.tasks.some((task) => task.tokens.confidence === 'exact')).toBe(true)
    const approximate = day.tasks.filter((task) => task.tokens.confidence !== 'exact')
    expect(approximate.length).toBeGreaterThan(0)
    for (const task of approximate) expect(task.tokens.caveat).toBeTruthy()
  })

  /**
   * Ловит вход, на котором безымянная задача неотличима от именованной.
   *
   * Макет рисует их по-разному: у одной модель и длительность второй строкой, у
   * другой — первый промпт в кавычках. Схлопни фикстура название с подстановкой
   * «без названия» — и разница исчезнет из данных, а вместе с ней из проверки.
   */
  it('есть задача без названия с первым промптом и задача с названием', () => {
    const untitled = day.tasks.filter((task) => task.title === null)
    expect(untitled.length).toBeGreaterThan(0)
    for (const task of untitled) expect(task.firstPrompt).toBeTruthy()
    expect(day.tasks.some((task) => task.title !== null && task.title.length > 0)).toBe(true)
  })

  /**
   * Ловит гистограмму, которую нельзя нарисовать составной: если ни в одном
   * часе нет двух провайдеров, «столбик делится по цветам» проверять не на чем.
   * И ловит час, чей итог разошёлся с кусками, — окно ищет по нему максимум.
   */
  it('в часах есть составной столбик, и итог часа равен сумме кусков', () => {
    expect(day.byHour.length).toBeGreaterThan(0)
    expect(day.byHour.some((bucket) => bucket.slices.length > 1)).toBe(true)
    let sum = 0
    for (const bucket of day.byHour) {
      expect(bucket.total).toBe(bucket.slices.reduce((total, slice) => total + slice.tokens, 0))
      expect(bucket.hour).toBeGreaterThanOrEqual(0)
      expect(bucket.hour).toBeLessThan(24)
      sum += bucket.total
    }
    expect(sum).toBe(day.totals.total.value)
  })

  /**
   * Ловит разрез по проектам без хвоста — на нём строку «+ 4 проекта»
   * проверять нечем, — и хвост, покрашенный в чей-то цвет: расход четырёх
   * проектов приписан бы одному провайдеру.
   */
  it('у проектов есть хвост без провайдера, у остальных строк провайдер есть', () => {
    const tail = day.byProject.filter((row) => row.folded !== undefined)
    expect(tail.length).toBe(1)
    expect(tail[0]).toBe(day.byProject.at(-1))
    expect(tail[0]!.folded).toBeGreaterThanOrEqual(2)
    expect(tail[0]!.provider).toBeNull()

    const named = day.byProject.filter((row) => row.folded === undefined)
    expect(named.length).toBeGreaterThan(0)
    for (const row of named) {
      expect(row.project, 'у именованной строки обязано быть имя').toBeTruthy()
      expect(row.provider, `${row.project}: не сказано, чей это расход`).not.toBeNull()
    }
    expect(day.byProject.reduce((sum, row) => sum + row.tokens.value, 0)).toBe(
      day.totals.total.value,
    )
  })

  /**
   * Ловит вход, на котором три пустых экрана сливаются в один.
   *
   * «Ещё ничего не прочитано», «за день ничего не делали» и «фильтр отсёк всё» —
   * разные слова, а данные у них отличаются двумя флагами. Совпади фикстуры — и
   * любая реализация покажет один экран вместо трёх.
   */
  it('пустой день и отсечённый фильтром различаются флагом, а не пустотой', () => {
    expect(emptyDay.tasks).toEqual([])
    expect(filtered.tasks).toEqual([])
    expect(emptyDay.emptyDay).toBe(true)
    expect(filtered.emptyDay).toBe(false)
    expect(emptyDay.emptyIndex).toBe(false)
    expect(filtered.emptyIndex).toBe(false)
    for (const report of [emptyDay, filtered]) {
      expect(report.folded).toBeNull()
      expect(report.byHour).toEqual([])
      expect(report.byProject).toEqual([])
    }
  })

  /**
   * Ловит карточку, уехавшую от ленты: заголовок карточки и строка, из которой
   * её открыли, — одни и те же данные, и разойтись они могут молча.
   */
  it('карточка описывает ту же задачу, что первая строка ленты', () => {
    expect(card.task).toEqual(day.tasks[0] as TaskRow)
  })

  /**
   * Ловит выдуманный процент: «25% дневного расхода» обязано быть настоящей
   * долей задачи в дне, иначе главное число карточки не проверено ничем.
   */
  it('доля задачи в дне — настоящая доля', () => {
    expect(card.dayShare).toBeCloseTo(card.task.tokens.value / day.totals.total.value, 9)
    expect(card.dayShare).toBeGreaterThan(0)
    expect(card.dayShare).toBeLessThanOrEqual(1)
  })

  /**
   * Ловит таймлайн, на котором нечего проверять: без выделенных столбиков
   * «красный красится по причине» зелено на любом коде, а без схождения суммы
   * высоты столбиков могут быть какими угодно.
   */
  it('таймлайн — по столбику на запрос, сумма равна расходу задачи, выделенные названы', () => {
    expect(card.timeline.length).toBe(card.task.requests)
    expect(card.timeline.reduce((sum, point) => sum + point.tokens, 0)).toBe(card.task.tokens.value)
    const marked = card.timeline.filter((point) => point.note !== undefined)
    expect(marked.length).toBeGreaterThanOrEqual(2)
    for (const point of marked) {
      expect(point.note).toBeTruthy()
      // Выделенный столбик обязан быть заметно выше рядового — иначе
      // «дороже прочих» подписано под тем, что таковым не является.
      expect(point.tokens).toBeGreaterThan(card.task.tokens.value / card.timeline.length)
    }
    expect(card.timelineNote).toBeTruthy()
    for (const [index, point] of card.timeline.entries()) {
      if (index > 0) expect(point.ts).toBeGreaterThan(card.timeline[index - 1]!.ts)
    }
  })

  /**
   * Ловит доли видов токенов, разошедшиеся со своими числами: полоса нарисуется
   * одной длины, а подпись рядом скажет другой процент.
   */
  it('четыре вида токенов сходятся с расходом задачи, доли — со своими числами', () => {
    expect(card.tokens.map((slice) => slice.kind)).toEqual([
      'input',
      'cacheWrite',
      'cacheRead',
      'output',
    ])
    const total = card.tokens.reduce((sum, slice) => sum + slice.tokens.value, 0)
    expect(total).toBe(card.task.tokens.value)
    for (const slice of card.tokens) {
      expect(slice.share).toBeCloseTo(slice.tokens.value / total, 9)
    }
    expect(card.tokens.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 9)
  })

  /**
   * Ловит список инструментов, на котором нечем проверить ни штриховку, ни
   * тревогу: без строки-оценки первое зелено на любом коде, без выделенной —
   * второе.
   */
  it('инструменты по расходу вниз, среди них есть оценка и есть выделенный', () => {
    const values = card.tools.map((row) => row.marginal.value)
    expect(values).toEqual([...values].sort((left, right) => right - left))
    expect(card.tools.reduce((sum, row) => sum + row.calls, 0)).toBe(card.task.toolCalls)

    const estimated = card.tools.filter((row) => row.marginal.confidence === 'estimate')
    expect(estimated.length).toBeGreaterThan(0)
    for (const row of estimated) expect(row.marginal.caveat).toBeTruthy()
    expect(card.tools.some((row) => row.marginal.confidence === 'exact')).toBe(true)

    const marked = card.tools.filter((row) => row.note !== undefined)
    expect(marked.length).toBeGreaterThan(0)
    for (const row of marked) expect(row.note).toBeTruthy()
  })
})
