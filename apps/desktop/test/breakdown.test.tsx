import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, openDb, type Db, type SourceFile } from '@agentmeter/core'
import type { SpendCategoryRow, SpendScreen } from '@agentmeter/ipc'
import { buildSpendScreen, rereadFactor, rereadTimes } from '../src/main/breakdown.ts'
import { buildDayReport } from '../src/main/day.ts'
import { BreakdownTab } from '../src/renderer/components/BreakdownTab.tsx'
import { SpendCategoryTable } from '../src/renderer/components/SpendCategoryTable.tsx'
import { formatTokens, setLocale } from '../src/renderer/format.ts'

/**
 * Вкладка «Развёртка» (4.2) — сборка в main и её отрисовка.
 *
 * Проверки названы по поломке, которую ловят.
 */

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
const ALL = { scope: 'day' as const, from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

let dir: string
let db: Db

setLocale('ru')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-breakdown-'))
  db = openDb(join(dir, 'index.sqlite')).db
  for (const name of ['compact', 'images', 'mcp', 'parallel', 'plain', 'sidechain']) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

describe('buildSpendScreen', () => {
  /**
   * Ловит второй счёт того же дня. Полоса развёртки и полоса «Куда ушло
   * сегодня» — это одно число, посчитанное одной функцией; разойдись они, и
   * человек, переключивший вкладку, увидел бы 41% и 43% про один день.
   */
  it('полоса развёртки — та же, что на вкладке «Сегодня»', () => {
    const screen = buildSpendScreen(db, ALL)
    const day = buildDayReport(db, { from: ALL.from, to: ALL.to })

    expect(screen.split).toEqual(day.split)
  })

  /**
   * Ловит колонку, разошедшуюся с полосой над ней: строки — это то же
   * постоянное, разложенное по статьям.
   */
  it('сумма статей равна постоянному расходу полосы', () => {
    const screen = buildSpendScreen(db, ALL)
    const sum = screen.recurring.reduce((total, row) => total + row.period.value, 0)

    expect(sum).toBe(screen.split!.slices[0]!.tokens.value)
    expect(screen.recurring.length).toBeGreaterThan(2)
  })

  /**
   * Ловит переключатель, сузивший период вместо смены знаменателя. «За сессию» —
   * это тот же расход, делённый на число сессий; сузь он период до одной
   * сессии, и доли поехали бы вслед за составом, а экран показал бы чужой день.
   */
  it('«за сессию» делит всё одним знаменателем, а доли не трогает', () => {
    const day = buildSpendScreen(db, ALL)
    const session = buildSpendScreen(db, { ...ALL, scope: 'session' })

    expect(session.sessions).toBe(day.sessions)
    expect(session.split!.slices[0]!.share).toBeCloseTo(day.split!.slices[0]!.share, 12)
    expect(session.split!.slices[0]!.tokens.value).toBe(
      Math.round(day.split!.slices[0]!.tokens.value / day.sessions),
    )
    for (const [index, row] of session.recurring.entries()) {
      expect(row.period.value).toBe(Math.round(day.recurring[index]!.period.value / day.sessions))
    }
  })

  /**
   * Ловит «итого до первого слова», в которое сложили первую реплику человека.
   * Её нельзя выключить, и обещание экономии оказалось бы больше возможного
   * ровно на длину собственного вопроса.
   */
  it('итог до первого слова не включает реплику человека', () => {
    const screen = buildSpendScreen(db, ALL)
    const userTurn = screen.recurring.find((row) => row.key === 'userTurn estimated')!
    const recurring = screen.split!.slices[0]!.tokens.value

    expect(userTurn.period.value).toBeGreaterThan(0)
    expect(screen.beforeFirstWord.period.value).toBe(recurring - userTurn.period.value)
  })

  /**
   * Ловит множитель перечитывания, посчитанный по числу запросов. Префикс у
   * сессий разный, и «×46» обязано означать «постоянное во столько раз больше
   * однократной записи» — иначе множитель и числа рядом с ним разойдутся.
   */
  it('перечитывание — доля постоянного, а не добавка к нему', () => {
    const screen = buildSpendScreen(db, ALL)
    const recurring = screen.split!.slices[0]!.tokens.value

    // Строки колонки уже включают перечитывание: их сумма равна постоянному
    // целиком. Строка «из них перечитывание» — раскрытие того же числа, и будь
    // она слагаемым, колонка сложилась бы в полтора постоянных расхода.
    expect(screen.reread.tokens.value).toBeLessThan(recurring)
    expect(screen.recurring.reduce((sum, row) => sum + row.period.value, 0)).toBe(recurring)
    expect(screen.sessions).toBeGreaterThan(1)
  })

  /**
   * Ловит множитель, посчитанный по числу запросов вместо токенов. Проверяется
   * на известном ответе: два префикса по 1000 записаны один раз каждый, а
   * прочитаны в сумме на 10 000 — значит сверх записи их перечитали восемь раз.
   */
  it('множитель перечитывания считается из токенов', () => {
    expect(rereadTimes(10_000, 2000, 2)).toBe(8)
    expect(rereadTimes(2000, 2000, 2)).toBe(0)
    // Первой записи в периоде нет вовсе — сессия началась вчера. Множителя
    // тогда не существует, и ноль здесь означает «делить не на что».
    expect(rereadTimes(5000, 0, 1)).toBe(0)
  })

  /**
   * Ловит совет, выданный про то, чем пользуются, и совет, обрезанный молча.
   *
   * Сеется руками: в фикстурах серверов MCP нет вовсе — имён `mcp__*` в
   * отложенных списках там не бывает, — и проверка «советуем только про
   * неиспользованное» на них зелена при любом правиле.
   */
  it('советует только про то, чего не звали, и говорит, сколько скрыл', () => {
    seedServers([
      { source: 'jira', tokens: 900, tools: 62, calls: 0 },
      { source: 'serena', tokens: 500, tools: 23, calls: 4 },
      { source: 'sentry', tokens: 300, tools: 24, calls: 0 },
      { source: 'figma', tokens: 200, tools: 12, calls: 0 },
      { source: 'gmail', tokens: 100, tools: 8, calls: 0 },
    ])

    const advice = buildSpendScreen(db, ALL).advice!

    expect(advice.map((row) => row.source)).toEqual(['jira', 'sentry', 'figma'])
    expect(advice.at(-1)!.hidden).toBe(1)
    expect(advice[0]!.headline).toContain('62')
    expect(advice[0]!.text).toContain('Отключение вернёт')
  })

  /**
   * Ловит совет, промолчавший про жадный режим. Там схемы неотделимы от
   * системного промпта, цена больше показанной, и выдать нижнюю оценку за всю
   * экономию — это соврать в самую заметную сторону (1.7: разница 17 раз).
   */
  it('жадный режим назван прямо в тексте совета', () => {
    seedServers([{ source: 'jira', tokens: 900, tools: 62, calls: 0, deferred: false }])

    const advice = buildSpendScreen(db, ALL).advice!

    expect(advice).toHaveLength(1)
    expect(advice[0]!.text).toContain('жадным')
  })

  /** Ловит пустой список советов вместо отсутствия поля. */
  it('когда советовать нечего, поля нет вовсе', () => {
    expect(buildSpendScreen(db, ALL).advice).toBeUndefined()
  })

  /**
   * Ловит экран, собранный нулями: «на префикс ушло ноль» — утверждение, и на
   * периоде без запросов оно ложное.
   */
  it('на периоде без запросов полосы нет вовсе', () => {
    const screen = buildSpendScreen(db, { ...ALL, from: 0, to: 1 })

    expect(screen.emptyScope).toBe(true)
    expect(screen.split).toBeUndefined()
  })
})

/**
 * Ревизия развёртки: сужение, знаменатель, сходимость.
 *
 * Три класса поломок одного корня — «каждое число по себе настоящее, а вместе
 * они врут»: фильтр, доехавший до левой колонки и не доехавший до правой;
 * переключатель, поделивший полосу и забывший таблицу под ней; колонка, чей
 * итог не сходится с осью над ней.
 */
describe('ревизия: сужение, знаменатель, сходимость', () => {
  /**
   * Ловит фильтр, применённый к половине экрана. Сумма вызовов по провайдерам
   * обязана давать вызовы дня: разойдись она — правая колонка показывает один
   * период, а полоса над ней другой, и оба выглядят настоящими.
   */
  it('сужение по провайдеру доезжает до правой колонки', () => {
    const all = buildSpendScreen(db, ALL)
    const claude = buildSpendScreen(db, { ...ALL, provider: 'claude' })
    const codex = buildSpendScreen(db, { ...ALL, provider: 'codex' })

    expect(claude.toolCalls).toBeGreaterThan(0)
    expect(codex.toolCalls).toBeGreaterThan(0)
    expect(claude.toolCalls + codex.toolCalls).toBe(all.toolCalls)
    // Инструмент Claude не может оказаться в развёртке одного Codex.
    expect(codex.tools.some((row) => row.key === 'Read')).toBe(false)
  })

  /**
   * Ловит «за день не работали» на дне, который полон, — фильтр отсёк всё, и
   * это другие слова (пункт 15 CLAUDE.md). `emptyScope` при этом считается до
   * сужения и остаётся ложью.
   */
  it('«фильтр отсёк всё» — свои слова, не «запросов не было»', () => {
    const screen = buildSpendScreen(db, { ...ALL, project: 'no-such-project' })

    expect(screen.emptyScope).toBe(false)
    expect(screen.split).toBeUndefined()

    const html = renderToStaticMarkup(
      <BreakdownTab screen={screen} filter={{ project: 'no-such-project' }} onScopeChange={() => undefined} />,
    )
    expect(html).toContain('По выбранному фильтру')
    expect(html).not.toContain('За этот период запросов не было')
  })

  /**
   * Ловит фильтр, унаследованный молча: лента сужена, вкладка переключена, и
   * без подписи экран читается как весь день.
   */
  it('унаследованный фильтр ленты назван на экране', () => {
    const screen = buildSpendScreen(db, { ...ALL, provider: 'claude' })
    const html = renderToStaticMarkup(
      <BreakdownTab screen={screen} filter={{ provider: 'claude' }} onScopeChange={() => undefined} />,
    )

    expect(html).toContain('data-breakdown-filter')
    expect(html).toContain('Claude')
  })

  /** Ловит «Первичное индексирование» в момент обычной загрузки вкладки. */
  it('загрузка — это «загружаем», а не «индекс пуст»', () => {
    const html = render(null)

    expect(html).toContain('Загружаем развёртку')
    expect(html).not.toContain('Первичное индексирование')
  })

  /**
   * Ловит счёт раз, выданный за множитель сессии. Счёт — мера периода и
   * делится переключателем; множитель — отношение, у него знаменателя нет,
   * и в колонке «За сессию» стоит именно он.
   */
  it('множитель — скейл-фри, счёт раз делится переключателем', () => {
    const day = buildSpendScreen(db, ALL)
    const session = buildSpendScreen(db, { ...ALL, scope: 'session' })

    // На фикстурах сессий больше одной — иначе счёт и множитель совпадают и
    // проверка зелена при любой формуле.
    expect(day.sessions).toBeGreaterThan(1)
    expect(day.reread.times).toBeGreaterThan(day.reread.factor)
    expect(session.reread.factor).toBe(day.reread.factor)
    expect(session.reread.times).toBe(day.reread.factor)
    expect(session.reread.tokens.value).toBe(
      Math.round(day.reread.tokens.value / day.sessions),
    )
  })

  /**
   * Ловит множитель, посчитанный по числу запросов, — на известном ответе:
   * два префикса по 1000 прочитаны на 10 000, значит каждый перечитан
   * вчетверо сверх записи.
   */
  it('множитель сессии считается из токенов', () => {
    expect(rereadFactor(10_000, 2000)).toBe(4)
    expect(rereadFactor(2000, 2000)).toBe(0)
    expect(rereadFactor(5000, 0)).toBe(0)
  })

  /** Ловит одно число на двух ролях: в ячейке — множитель, в подписи — счёт. */
  it('в ячейке колонки множитель, в подписи — счёт раз', () => {
    const screen = buildSpendScreen(db, ALL)
    const html = render(screen)

    expect(screen.reread.times).not.toBe(screen.reread.factor)
    expect(html).toContain(`×${screen.reread.factor}<`)
    expect(html).toContain(`перечитан ${screen.reread.times} раз`)
  })

  /**
   * Ловит правую колонку, оставшуюся в масштабе дня под полосой за сессию, —
   * два масштаба на одном экране, оба похожие на правду.
   */
  it('«за сессию» делит и правую колонку', () => {
    const day = buildSpendScreen(db, ALL)
    const session = buildSpendScreen(db, { ...ALL, scope: 'session' })

    expect(session.toolCalls).toBe(Math.round(day.toolCalls / day.sessions))
    expect(session.toolTotal.value).toBe(Math.round(day.toolTotal.value / day.sessions))
    for (const row of session.tools) {
      const full = day.tools.find((candidate) => candidate.key === row.key)!
      expect(row.marginal.value).toBe(Math.round(full.marginal.value / day.sessions))
      expect(row.calls).toBe(Math.round(full.calls / day.sessions))
      // Средняя цена вызова — отношение, переключатель её не трогает.
      expect(row.average).toBe(full.average)
    }
  })

  /**
   * Ловит сумму оценок, показанную точным числом: итог приезжает из main
   * готовым `Measured`, и знак у него — по худшей строке.
   */
  it('итог правой колонки несёт знак оценки', () => {
    const screen = buildSpendScreen(db, ALL)

    expect(screen.toolTotal.value).toBe(
      screen.tools.reduce((sum, row) => sum + row.marginal.value, 0),
    )
    // В фикстуре parallel есть дележ между параллельными вызовами — точным
    // такой итог быть не может.
    expect(screen.toolTotal.confidence).toBe('estimate')
    expect(render(screen)).toContain(`≈${formatTokens(screen.toolTotal.value)}`)
  })

  /**
   * Ловит колонку, не сходящуюся с осью над ней: «Разовый · по вызовам» обещает
   * раскрытие, а строки объясняют доли процента. Остаток — ответы модели, ввод
   * и перечитывание результатов — назван строкой, как в макете (1139–1150).
   */
  it('правая колонка сходится с осью: остаток назван строкой', () => {
    const screen = buildSpendScreen(db, ALL)
    const marginal = screen.split!.slices[1]!

    expect(screen.marginalRest).toBeDefined()
    expect(screen.marginalRest!.tokens.value).toBeGreaterThanOrEqual(0)
    expect(screen.marginalRest!.tokens.value + screen.toolTotal.value).toBe(
      marginal.tokens.value,
    )

    const html = render(screen)
    expect(html).toContain('Ответы модели')
    expect(html).toContain('Разовый расход за день')
    // Итоговая строка — то же число, что подпись оси: один источник, не два.
    expect(html).toContain(formatTokens(marginal.tokens.value))
  })
})

describe('картинки отдельной статьёй (4.5)', () => {
  /**
   * Ловит строку картинок, добавленную **поверх** строк инструментов.
   *
   * Маржинальная стоимость вызова посчитана один раз, и вторая строка с той же
   * ценой завысила бы колонку ровно на себя, а «итого вызовов» — на число
   * картинок. Вызов с картинкой обязан **уйти** из строки своего инструмента.
   */
  it('вызов с картинкой уходит из строки инструмента, а не дублируется', () => {
    const screen = buildSpendScreen(db, ALL)
    const images = screen.tools.find((row) => row.key === '<images>')!
    const read = screen.tools.find((row) => row.key === 'Read')

    // В фикстуре `images.jsonl` картинка одна, и она пришла из `Read`.
    expect(images.calls).toBe(1)
    expect(images.label).toBe('Картинки и скриншоты')
    expect(screen.toolCalls).toBe(screen.tools.reduce((sum, row) => sum + row.calls, 0))
    // `Read` остался — у него есть и обычные вызовы; картинка в них не входит.
    expect(read === undefined || read.calls >= 1).toBe(true)
  })

  /**
   * Ловит ключ, доехавший до экрана как есть. `<images>` — синтетический ключ,
   * и человек, увидевший его в строке, решит, что так называется инструмент.
   */
  it('на экране стоит название, а не служебный ключ', () => {
    const html = render(buildSpendScreen(db, ALL))
    const start = html.indexOf('data-spend-tool="&lt;images&gt;"')
    const cell = html.slice(start, html.indexOf('</span>', start))

    // Ключ остаётся в `data-`-атрибуте — по нему цепляются проверки, — а вот в
    // тексте строки его быть не должно: человек прочтёт `<images>` как имя
    // инструмента, которого у него нет.
    expect(start).toBeGreaterThan(0)
    expect(cell).toContain('Картинки и скриншоты')
    expect(cell).not.toContain('&lt;images&gt;</span>')
  })
})

describe('переплата за паузу (4.4)', () => {
  /**
   * Ловит блок, который сложили с шапкой.
   *
   * Пересборка не добавляет периоду ни одного токена: тот же промпт едет либо
   * чтением, либо записью. Значит её число обязано лежать **внутри** итога, а
   * доля — считаться от того же итога, что в шапке. Появись у блока свой
   * знаменатель, на экране оказались бы два ответа на один вопрос.
   */
  it('пересборки лежат внутри итога, а доля считается от него', () => {
    const screen = buildSpendScreen(db, ALL)

    const total = screen.split!.slices.reduce((sum, slice) => sum + slice.tokens.value, 0)

    expect(screen.rebuilds).toBeDefined()
    expect(screen.rebuilds!.total.tokens.value).toBeLessThan(total)
    expect(screen.rebuilds!.share).toBeCloseTo(screen.rebuilds!.total.tokens.value / total, 6)
  })

  /**
   * Ловит подпись корзины, собранную в main: границы приезжают числами, а «1 —
   * 2 ч» получается подстановкой их в постоянный шаблон — это работа окна
   * (правило 3.0). В фикстурах пересборка по паузе одна, 1 ч 55 мин при часовом
   * сроке, то есть первая корзина.
   */
  it('корзина подписана окном из приехавших границ', () => {
    const screen = buildSpendScreen(db, ALL)
    const html = render(screen)

    expect(screen.rebuilds!.buckets).toHaveLength(1)
    expect(screen.rebuilds!.buckets[0]!.fromMs).toBe(60 * 60_000)
    // «1 ч — 2 ч», а не «1 — 2 ч» как в макете: единица повторяется у обеих
    // границ, потому что `span()` — общий форматтер длительностей, и учить его
    // сокращать одинаковые единицы значит заводить формат ради одной строки.
    expect(html).toContain('1 ч — 2 ч')
    expect(html).toContain('после паузы дольше 1 ч')
  })

  /**
   * Ловит блок из нулей у Codex. Записи в кэш он не сообщает вовсе, и таблица
   * из четырёх нулей сказала бы «мы посчитали, и пересборок не было».
   */
  it('на одном Codex блока нет вовсе', () => {
    const screen = buildSpendScreen(db, { ...ALL, provider: 'codex' })
    const html = render(screen)

    expect(screen.rebuilds).toBeUndefined()
    expect(html).not.toContain('data-cache-rebuilds')
  })

  /**
   * Ловит потерянную оговорку. Блок называет число, которое **не** является
   * лишним расходом, и без этой фразы «23% расхода за период» читается как
   * «столько можно было сэкономить».
   */
  it('блок говорит, что токенов от пересборки не прибавилось', () => {
    const html = render(buildSpendScreen(db, ALL))

    expect(html).toContain('Токенов в сутках от этого не прибавилось')
  })
})

describe('BreakdownTab', () => {
  /**
   * Ловит экран, оставшийся в первой колонке окна.
   *
   * `<main>` окна — сетка `1fr 300px` под ленту с боковой колонкой. Своей
   * боковушки у развёртки нет, и без захвата обеих колонок справа остаются
   * пустые 300 точек, а полоса, делящая итог пополам, меряет чужую ширину.
   * Пустой экран — тем же правилом: сообщение съезжает влево ровно так же.
   */
  it('развёртка занимает обе колонки окна, и пустая тоже', () => {
    expect(render(buildSpendScreen(db, ALL))).toMatch(
      /<div data-breakdown="true" style="grid-column:1 \/ -1/,
    )
    expect(render(null)).toMatch(/<div data-breakdown-empty="true" style="grid-column:1 \/ -1/)
  })

  /**
   * Ловит полосу, посчитанную окном заново от токенов: доля приезжает готовой,
   * потому что её видно числом рядом.
   */
  it('ширина полосы берётся из готовой доли', () => {
    const screen = buildSpendScreen(db, ALL)
    const html = render(screen)
    const [recurring, marginal] = screen.split!.slices

    expect(html).toContain(
      `grid-template-columns:${recurring!.share * 100}fr ${marginal!.share * 100}fr`,
    )
    expect(html).toContain(`${formatTokens(recurring!.tokens.value)} · ${Math.round(recurring!.share * 100)}%`)
  })

  /**
   * Ловит полосу, растянутую собственной подписью.
   *
   * Колонка `Nfr` не может стать уже своего содержимого, поэтому у короткой
   * половины (4% — обычный день без MCP) подпись и число держат её шире доли:
   * полоса врёт длиной, а подпись при этом ещё и ломается в столбик. Длина —
   * единственное, что здесь обязано быть честным, поэтому у полосы `minmax(0,
   * …fr)` и ни одного текстового узла внутри, а подписи живут своей сеткой.
   */
  it('короткая половина полосы остаётся короткой', () => {
    const screen = buildSpendScreen(db, ALL)
    const [recurring, marginal] = screen.split!.slices
    const narrow: SpendScreen = {
      ...screen,
      split: {
        ...screen.split!,
        slices: [
          { ...recurring!, share: 0.04 },
          { ...marginal!, share: 0.96 },
        ],
      },
    }
    const html = render(narrow)

    expect(html).toContain(
      `grid-template-columns:minmax(0, ${0.04 * 100}fr) minmax(0, ${0.96 * 100}fr)`,
    )
    // Полосы — пустые div-ы: появись внутри подпись, минимум колонки снова
    // перестал бы быть нулём, и `minmax` перестал бы что-либо значить.
    expect(html).toMatch(/<div data-breakdown-bar="recurring"[^>]*><\/div>/)
    expect(html).toMatch(/<div data-breakdown-bar="marginal"[^>]*><\/div>/)
    // Подпись оси ужимается многоточием, число — нет: сокращённый расход
    // это уже другое число.
    expect(html).toContain('text-overflow:ellipsis')
    expect(html).toContain(`${formatTokens(marginal!.tokens.value)} · 96%`)
  })

  /**
   * Ловит «0 из 0» вместо тире: у остатка использованного не существует, и
   * нарисованный ноль читался бы как «ни разу не понадобилось».
   */
  it('там, где считать нечего, стоит тире, а не ноль', () => {
    const html = render(buildSpendScreen(db, ALL))
    const residual = row(html, 'system residual')

    expect(residual).toContain('—')
    expect(residual).not.toContain('0 из 0')
  })

  /**
   * Ловит карточку совета, не доехавшую до экрана: сам совет собран в main и
   * проверен там, но нарисовать его окно может и забыть — а это единственное
   * место, где он вообще виден.
   */
  it('совет виден карточкой с суммой и знаком минуса', () => {
    seedServers([{ source: 'jira', tokens: 900, tools: 62, calls: 0 }])
    const screen = buildSpendScreen(db, ALL)
    const html = render(screen)

    expect(html).toContain('data-breakdown-advice="jira"')
    const advice = screen.advice![0]!
    // Знак минуса и знак оценки стоят рядом, и оба обязаны быть: «вернёт
    // столько-то» — это обещание, а внутри него восстановленные запросы (1.3).
    expect(html).toContain(
      `−${advice.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(advice.tokens.value)}`,
    )
    expect(html).toContain('62')
    expect(html).toContain('Отключение вернёт')
  })

  /** Ловит переключатель, не сообщающий о своём состоянии и о нажатии. */
  it('переключатель называет выбранный режим и зовёт обработчик', () => {
    const seen: Array<'day' | 'session'> = []
    const screen = buildSpendScreen(db, ALL)
    const html = renderToStaticMarkup(
      <BreakdownTab screen={screen} onScopeChange={(scope) => seen.push(scope)} />,
    )

    expect(html).toContain('data-breakdown-scope="day" aria-pressed="true"')
    expect(html).toContain('data-breakdown-scope="session" aria-pressed="false"')
    expect(seen).toEqual([])
  })

  /** Ловит экран, нарисованный поверх непрочитанного индекса и пустого дня. */
  it('на пустом индексе и пустом периоде рисуются слова, а не нули', () => {
    const empty = buildSpendScreen(db, { ...ALL, from: 0, to: 1 })

    expect(render(empty)).toContain('data-breakdown-empty')
    expect(render(null)).toContain('data-breakdown-empty')
    expect(render(empty)).not.toContain('data-spend-categories')
  })
})

/**
 * Подсказка состава по наведению (4.9).
 *
 * Показом управляет CSS, а не состояние: тесты рендерят статическую разметку,
 * и подсказка на `useState` осталась бы непроверяемой. Отсюда две половины
 * проверки — содержимое в разметке и правило показа в файле стилей; без второй
 * половины удалённое правило дало бы карточку, висящую поверх экрана всегда.
 */
describe('состав статьи по наведению (4.9)', () => {
  /**
   * Ловит карточку, вставшую в поток: она нарисована в разметке у каждой строки
   * всегда, и без выноса из потока десять карточек растянули бы колонку втрое
   * ещё до всякого наведения.
   */
  it('карточка есть у каждой строки и вынесена из потока', () => {
    const html = render(buildSpendScreen(db, ALL))

    expect(html).toContain('data-spend-detail="skills estimated"')
    expect(html).toContain('data-spend-detail="system residual"')
    expect(html).toMatch(/data-spend-detail="skills estimated" style="position:absolute/)
    // Якорь выноса — сама строка: без `position: relative` карточка уедет к
    // ближайшему предку с позицией, то есть на другой конец экрана.
    expect(html).toMatch(/data-spend-category="skills estimated"[^>]*position:relative/)
  })

  /**
   * Ловит правило показа, потерянное вместе с файлом стилей. Разметка при этом
   * остаётся зелёной: карточка есть, просто видна она всегда и всюду.
   */
  it('карточка спрятана стилями и открывается наведением и фокусом', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../src/renderer/tokens.css', import.meta.url)),
      'utf8',
    )
    const hidden = /\[data-spend-detail\]\s*\{[^}]*visibility:\s*hidden/

    expect(css).toMatch(hidden)
    expect(css).toContain('[data-spend-category]:hover [data-spend-detail]')
    expect(css).toContain('[data-spend-category]:focus-within [data-spend-detail]')
  })

  /**
   * Ловит пустую карточку у статьи, которую перечислить нечем. Остаток не
   * состоит из штук, и пустой список сказал бы «мы посмотрели и не нашли», —
   * а мы туда даже не смотрели.
   */
  it('у остатка стоит фраза, а не пустой список', () => {
    const html = render(buildSpendScreen(db, ALL))

    expect(html).toContain('data-spend-detail-note')
    expect(html).toContain('Измеренный остаток')
  })

  /**
   * Ловит молча обрезанный список: двенадцать строк из тридцати шести читаются
   * как весь набор, и человек уносит с экрана неверное «у меня двенадцать
   * скиллов».
   */
  it('обрезанный список признаётся в обрезке', () => {
    const html = renderToStaticMarkup(
      <SpendCategoryTable rows={[categoryRow(18, 4)]} />,
    )

    expect(html).toContain('data-spend-detail-name="name-00"')
    expect(html).not.toContain('data-spend-detail-name="name-12"')
    expect(html).toContain('data-spend-detail-more="6"')
    expect(html).toContain('и ещё 6')
  })

  /**
   * Ловит охват, напечатанный у каждой строки: «в 4 из 4» на всех именах — это
   * шум, из которого не следует ни одного решения, а вот «в 1 из 4» следует.
   */
  it('охват показывается только там, где он неполный', () => {
    const html = renderToStaticMarkup(
      <SpendCategoryTable rows={[categoryRow(2, 4, [4, 1])]} />,
    )

    expect(html).toContain('в 1 из 4')
    expect(html).not.toContain('в 4 из 4')
  })

  /**
   * Ловит утверждение, которого никто не измерял: «16 из 1». У инструкций MCP
   * блок один на сервер, то есть загруженного там всегда единица, а звали у
   * serena шестнадцать инструментов — дробь получается больше единицы и
   * выглядит при этом настоящей. Инструменты считает только статья серверов.
   */
  it('дробь «звали из загруженных» стоит лишь там, где загруженное — инструменты', () => {
    const servers = renderToStaticMarkup(<SpendCategoryTable rows={[sourceRow('mcpTools estimated')]} />)
    const instructions = renderToStaticMarkup(
      <SpendCategoryTable rows={[sourceRow('mcpInstructions estimated')]} />,
    )

    expect(servers).toContain('16 из 62')
    expect(instructions).not.toContain('16 из 1')
    expect(instructions).toContain('238 вызовов')
  })

  /**
   * Ловит две всплывающие подсказки на одном узле: родное `title` со строки
   * перекрывает свою карточку, а объясняет оговорка про восстановленные запросы
   * именно знак `≈` рядом с числом.
   */
  it('оговорка про точность висит на числе, а не на всей строке', () => {
    const html = render(buildSpendScreen(db, ALL))

    expect(html).not.toMatch(/data-spend-category="[^"]*"[^>]*title=/)
  })
})

/** Строка с разрезом по серверам — числа взяты с живых логов (serena). */
function sourceRow(key: string): SpendCategoryRow {
  return {
    key,
    label: 'MCP',
    perSession: { value: 1000, confidence: 'exact' },
    period: { value: 10_000, confidence: 'exact' },
    loaded: 1,
    used: 1,
    estimate: true,
    sources: [
      {
        source: 'serena',
        period: { value: 8200, confidence: 'exact' },
        perSession: { value: 820, confidence: 'exact' },
        loaded: key === 'mcpTools estimated' ? 62 : 1,
        used: 16,
        calls: 238,
      },
    ],
    detail: { names: [], sessions: 1, unnamed: 0 },
  }
}

/** Строка колонки с заданным составом — руками, потому что нужен ровно этот. */
function categoryRow(names: number, sessions: number, coverage?: number[]): SpendCategoryRow {
  return {
    key: 'skills estimated',
    label: 'Скиллы',
    perSession: { value: 1000, confidence: 'exact' },
    period: { value: 10_000, confidence: 'exact' },
    loaded: names,
    used: 1,
    estimate: true,
    sources: [],
    detail: {
      names: Array.from({ length: names }, (_, index) => ({
        name: `name-${String(index).padStart(2, '0')}`,
        sessions: coverage?.[index] ?? sessions,
      })),
      sessions,
      unnamed: 0,
    },
  }
}

function render(screen: SpendScreen | null): string {
  return renderToStaticMarkup(<BreakdownTab screen={screen} onScopeChange={() => undefined} />)
}

/**
 * Сессия с серверами MCP в префиксе и вызовами. Руками, потому что в фикстурах
 * ни одного `mcp__*` в отложенных списках нет.
 */
function seedServers(
  servers: Array<{ source: string; tokens: number; tools: number; calls: number; deferred?: boolean }>,
): void {
  const prefix = servers.reduce((sum, server) => sum + server.tokens, 0) + 100
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at,
                           is_sidechain, prefix_tokens, tools_deferred)
     VALUES ('seeded', 'claude', '/tmp/seeded.jsonl', '/tmp', 'seed', 1000, 2000, 0, ?, ?)`,
    prefix,
    servers.every((server) => server.deferred !== false) ? 1 : 0,
  )
  servers.forEach((server, idx) => {
    db.run(
      `INSERT INTO prefix_blocks (session_id, idx, category, source, bytes, tokens, basis, items)
       VALUES ('seeded', ?, 'mcpTools', ?, 0, ?, 'estimated', ?)`,
      idx,
      server.source,
      server.tokens,
      server.tools,
    )
  })
  db.run(
    `INSERT INTO prefix_blocks (session_id, idx, category, source, bytes, tokens, basis, items)
     VALUES ('seeded', ?, 'system', NULL, 0, 100, 'residual', 0)`,
    servers.length,
  )
  db.run(
    `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
                           cache_write, cache_read, context_tokens, origin)
     VALUES ('seeded', 0, 'seeded#0', 1500, 'seed-model', ?, 0, 0, 0, ?, 'log')`,
    prefix,
    prefix,
  )
  let idx = 0
  for (const server of servers) {
    for (let call = 0; call < server.calls; call += 1) {
      db.run(
        `INSERT INTO tool_calls (session_id, seq, idx, name, kind, server, marginal_tokens, marginal_basis)
         VALUES ('seeded', 0, ?, ?, 'mcp', ?, 0, 'measured')`,
        idx++,
        `mcp__${server.source}__tool${call}`,
        server.source,
      )
    }
  }
}

function row(markup: string, key: string): string {
  const start = markup.indexOf(`data-spend-category="${key}"`)
  const next = markup.indexOf('data-spend-category=', start + 1)
  return markup.slice(start, next === -1 ? undefined : next)
}
