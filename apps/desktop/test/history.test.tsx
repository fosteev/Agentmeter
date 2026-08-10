import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, openDb, setLocale, type Config, type Db } from '@agentmeter/core'
import type { HistoryScreen } from '@agentmeter/ipc'
import { buildHistoryScreen } from '../src/main/history.ts'
import { HistoryTab } from '../src/renderer/components/HistoryTab.tsx'
import { setLocale as setRendererLocale } from '../src/renderer/format.ts'

/**
 * Вкладка «История» (4.6).
 *
 * Всё на посеянном индексе, и это не выбор стиля. Экран отвечает на вопрос «чем
 * день с нулём отличается от дня без данных», а фикстуры лежат в трёх соседних
 * сутках подряд: дня, в который человек не работал, среди них нет вовсе, и
 * проверка на них была бы зелена при любом правиле. Здесь дни расставлены
 * руками, и `now` приезжает параметром — иначе завтрашний день зависел бы от
 * того, когда запускают тесты.
 */

const config: Config = { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, locale: 'ru' } }

/** Понедельник 3 августа 2026, полдень, локальное время. */
const MONDAY = new Date(2026, 7, 3, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000
/** «Сейчас» — суббота 8 августа: воскресенье 9-го ещё не наступило. */
const NOW = new Date(2026, 7, 8, 18, 0, 0).getTime()

let dir: string
let db: Db

beforeEach(() => {
  setLocale('ru')
  setRendererLocale('ru')
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-history-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('buildHistoryScreen', () => {
  /**
   * Ловит схлопывание трёх пустот в одну — ту самую поломку, ради которой
   * дизайн нарисовал три разных столбика.
   *
   * Понедельник и среда с расходом, вторник пуст, воскресенье в будущем. У
   * вторника обязан быть **ноль**: логи этих суток прочитаны, запросов в них
   * нет. У воскресенья — `null`: этих суток мы не видели, и ноль был бы
   * утверждением, которого мы не делали.
   */
  it('день с нулём и день без данных — разные значения, а не одно', () => {
    seed(MONDAY, 'claude', 10, 1000)
    seed(MONDAY + 2 * DAY, 'claude', 11, 3000)

    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const byDay = new Map(screen.days.map((day) => [dayIndex(day.at), day.tokens]))

    expect(byDay.get(0)?.value).toBe(1000)
    expect(byDay.get(1)?.value).toBe(0)
    expect(byDay.get(2)?.value).toBe(3000)
    // Суббота — сегодня, работы не было: измеренный ноль.
    expect(byDay.get(5)?.value).toBe(0)
    // Воскресенье ещё не наступило.
    expect(byDay.get(6)).toBeNull()
  })

  /**
   * Ловит измеренный ноль там, где лог просто удалён (M5, «Ретеншн индекса»).
   *
   * Claude Code чистит свои транскрипты сам, и раньше первого уцелевшего лога
   * утверждать «запросов Claude не было» нельзя. Сутки с расходом Codex — это
   * нижняя граница, сутки без расхода — незнание, а не ноль. Случая нет ни в
   * одной фикстуре: там все сутки покрыты обоими провайдерами сразу, и проверка
   * на них была бы зелена при любом правиле — поэтому сеется руками.
   */
  it('сутки раньше первого лога Claude — нижняя граница, а дальше измерение', () => {
    seed(MONDAY, 'codex', 10, 1000)
    seed(MONDAY + 2 * DAY, 'claude', 11, 3000)

    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const byDay = new Map(screen.days.map((day) => [dayIndex(day.at), day.tokens]))

    expect(byDay.get(0)?.value).toBe(1000)
    expect(byDay.get(0)?.confidence).toBe('estimate')
    expect(byDay.get(0)?.caveat).toContain('удалены')
    // Вторник раньше границы и пуст: сказать про него нечего.
    expect(byDay.get(1)).toBeNull()
    // Среда — первый уцелевший лог Claude, отсюда числа измеренные.
    expect(byDay.get(2)?.confidence).toBe('exact')
    // Четверг пуст, но уже внутри покрытия обоих: это измеренный ноль.
    expect(byDay.get(3)?.value).toBe(0)
    expect(byDay.get(3)?.confidence).toBe('exact')
    // Итог периода содержит нижнюю границу, значит и сам нижняя граница.
    expect(screen.total.confidence).not.toBe('exact')
  })

  /**
   * Ловит правило, обобщённое до «максимума по провайдерам». Знак, который
   * стоит везде, не значит ничего: человек, попробовавший Codex в среду, не
   * должен получить оценку на всей своей клодовой истории. Границу двигает
   * только Claude — он единственный, кто удаляет свои логи (замер: 191 сутки
   * роллаутов Codex против 54 у Claude на одной машине).
   */
  it('появление второго провайдера не делает прошлое оценкой', () => {
    seed(MONDAY, 'claude', 10, 1000)
    seed(MONDAY + 2 * DAY, 'codex', 11, 3000)

    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const byDay = new Map(screen.days.map((day) => [dayIndex(day.at), day.tokens]))

    expect(byDay.get(0)?.confidence).toBe('exact')
    expect(byDay.get(1)?.value).toBe(0)
    expect(byDay.get(2)?.confidence).toBe('exact')
    expect(screen.total.confidence).toBe('exact')
  })

  /**
   * Ловит подпись, которая называет пустой столбик пустым, не различая почему.
   * Слова про день без данных обязаны приезжать готовыми: причину знает тот,
   * кто знает границы наблюдаемого окна (правило 3.0).
   */
  it('подпись про покрытие называет день без данных', () => {
    seed(MONDAY, 'claude', 10, 1000)

    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)

    expect(screen.coverage).toContain('дней с данными')
    expect(screen.coverage).toContain('данных нет')
    expect(screen.daysWithSpend).toBe(1)
  })

  /**
   * Ловит день, склеенный вторым запросом: сумма клеток хитмапа обязана быть
   * равна высоте столбика над ней. Разойдись они — на экране два числа про одни
   * сутки, и оба настоящие.
   */
  it('сумма клеток часа равна итогу столбика', () => {
    seed(MONDAY, 'claude', 9, 700)
    seed(MONDAY, 'codex', 14, 300)
    seed(MONDAY, 'claude', 14, 100)

    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const monday = screen.days.find((day) => dayIndex(day.at) === 0)!

    expect(monday.tokens?.value).toBe(1100)
    expect(monday.hours.reduce((sum, hour) => sum + hour.tokens, 0)).toBe(1100)
    expect(monday.hours.filter((hour) => hour.tokens > 0).map((hour) => hour.hour)).toEqual([9, 14])
    expect(screen.total.value).toBe(1100)
  })

  /**
   * Ловит цвет клетки, взятый у дня вместо часа. День клодовый — 800 против
   * 300, — но в четырнадцатом часу больше набрал Codex, и покрасить его клетку
   * янтарным значит показать работу, которой в этот час не было.
   */
  it('цвет клетки — провайдер часа, а не дня', () => {
    seed(MONDAY, 'claude', 9, 800)
    seed(MONDAY, 'codex', 14, 300)
    seed(MONDAY, 'claude', 14, 100)

    const monday = buildHistoryScreen(db, { span: 'week' }, config, NOW).days.find(
      (day) => dayIndex(day.at) === 0,
    )!

    expect(monday.byProvider[0]?.provider).toBe('claude')
    expect(monday.hours[9]?.provider).toBe('claude')
    expect(monday.hours[14]?.provider).toBe('codex')
    expect(monday.hours[0]?.provider).toBeNull()
  })

  /**
   * Ловит правую колонку, посчитанную по другому дню: выбранный день и столбик
   * над ним — это одни сутки, и их итоги обязаны совпасть.
   */
  it('сводка справа — про выбранный день и с теми же числами', () => {
    seed(MONDAY, 'claude', 10, 1000)
    seed(MONDAY + 2 * DAY, 'claude', 11, 3000)

    const chosen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const asked = buildHistoryScreen(
      db,
      { span: 'week', at: chosen.days.find((day) => dayIndex(day.at) === 0)!.at },
      config,
      NOW,
    )

    // Без просьбы раскрыт последний день с расходом, а не последний день недели.
    expect(dayIndex(chosen.selected!.at)).toBe(2)
    expect(chosen.selected!.total.value).toBe(3000)
    expect(dayIndex(asked.selected!.at)).toBe(0)
    expect(asked.selected!.total.value).toBe(1000)
    expect(asked.selected!.tokens.reduce((sum, slice) => sum + slice.tokens.value, 0)).toBe(1000)
  })

  /**
   * Ловит период, отсчитанный от последнего дня с расходом. Человек, не
   * работавший три дня, спрашивает «что было за неделю», а не «за неделю,
   * кончившуюся в среду»: пустые столбики справа — это ответ.
   */
  it('неделя кончается сегодня, а не последним днём с расходом', () => {
    seed(MONDAY, 'claude', 10, 1000)

    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)

    expect(screen.days).toHaveLength(7)
    expect(dayIndex(screen.days.at(-1)!.at)).toBe(6)
    expect(screen.to).toBeGreaterThan(NOW)
  })

  /** Ловит пустой экран, показанный числами: на пустом индексе показывать нечего. */
  it('на пустом индексе истории нет вовсе', () => {
    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)

    expect(screen.emptyIndex).toBe(true)
    expect(screen.firstDay).toBeNull()
    expect(screen.selected).toBeUndefined()
  })
})

describe('HistoryTab', () => {
  /**
   * Ловит три пустоты, нарисованные одинаково. У дня с нулём — «0» и полоска, у
   * дня без данных — тире и пустая рамка; различить их на экране можно только
   * так, и разметка обязана это показывать.
   */
  it('ноль, отсутствие данных и расход рисуются по-разному', () => {
    seed(MONDAY, 'claude', 10, 1000)
    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const html = render(screen)

    expect(html).toContain('data-history-day-state="spend"')
    expect(html).toContain('data-history-day-state="zero"')
    expect(html).toContain('data-history-day-state="absent"')
    expect(html).toContain('—')
  })

  /**
   * Ловит столбик, стёртый округлением. День на 1/500 от самого высокого даёт
   * четверть пикселя, и без нижней границы на экране осталось бы пустое место —
   * то есть «работы не было» вместо «работы было на два процента».
   */
  it('маленький столбик не исчезает совсем', () => {
    seed(MONDAY, 'claude', 10, 500_000)
    seed(MONDAY + DAY, 'claude', 10, 1000)
    const screen = buildHistoryScreen(db, { span: 'week' }, config, NOW)
    const html = render(screen)
    // Ровно тот вторник, а не «первое, что нашлось со словом spend»: полоска в
    // два пикселя есть и у дня с нулём, и проверка «где-то дальше по разметке
    // встречается height:2px» зелена при любом правиле — эта её версия
    // переживала мутацию «стирать округлением».
    const tuesday = screen.days.find((day) => dayIndex(day.at) === 1)!
    const start = html.indexOf(`data-history-day="${tuesday.at}"`)
    const cell = html.slice(start, html.indexOf('</button>', start))

    expect(tuesday.tokens?.value).toBe(1000)
    expect(cell).toContain('data-history-day-state="spend"')
    expect(cell).toContain('height:2px')
  })
})

function render(screen: HistoryScreen): string {
  return renderToStaticMarkup(
    <HistoryTab screen={screen} onSpanChange={() => {}} onSelectDay={() => {}} />,
  )
}

/** Номер дня недели от понедельника 3 августа. */
function dayIndex(at: number): number {
  return Math.round((at - new Date(2026, 7, 3).getTime()) / DAY)
}

/**
 * Один запрос в заданный час заданного дня.
 *
 * Индекс сеется напрямую: собрать транскрипт с нужными сутками и часами —
 * это тот же посев, только в обход разбора, и ошибка в нём была бы неотличима
 * от ошибки в проверяемом коде.
 */
function seed(day: number, provider: 'claude' | 'codex', hour: number, tokens: number): void {
  const date = new Date(day)
  const ts = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 30, 0, 0).getTime()
  const id = `${provider}-${ts}`
  // Строка источника обязательна: без неё индекс считается несобранным
  // (`sourceCount === 0`), и `todayReport` честно отвечает «показывать нечего»
  // — то есть проверка мерила бы пустой экран, а не историю.
  db.run(
    `INSERT OR IGNORE INTO sources (path, provider, inode, size, mtime, offset, parsed_at)
     VALUES (?, ?, 1, 1, 1, 0, 1)`,
    `/tmp/${id}.jsonl`,
    provider,
  )
  db.run(
    `INSERT OR IGNORE INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                                     is_sidechain, prefix_tokens, tools_deferred)
     VALUES (?, ?, ?, '/tmp', 'seed', ?, ?, 0, 0, 0)`,
    id,
    provider,
    `/tmp/${id}.jsonl`,
    ts,
    ts,
  )
  db.run(
    `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                           cache_write, cache_read, context_tokens, origin)
     VALUES (?, 0, ?, ?, 'seed-model', ?, 0, 0, 0, ?, 'log')`,
    id,
    `${id}#0`,
    ts,
    tokens,
    tokens,
  )
}
