import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  changedFiles,
  ingestFile,
  openDb,
  taskRows,
  type Config,
  type Db,
  type SourceFile,
} from '@agentmeter/core'
import { setLocale } from '@agentmeter/core'
import type { TimelinePoint } from '@agentmeter/ipc'
import { buildDayReport } from '../src/main/day.ts'
import { buildTaskCard, note, timelineNote } from '../src/main/task.ts'

/**
 * `TaskCard` на настоящем индексе (3.4).
 *
 * Половина проверок идёт по фикстурам, половина по посеянному индексу — и это
 * не дублирование. Фикстуры показывают, что карточка собирается из настоящих
 * логов и сходится с лентой; модель выделения на них молчит, потому что
 * дорогих запросов там нет вовсе, а проверка на входе без нужного случая
 * зелена при любом правиле. Поэтому пороги и причины проверяются на посеве, где
 * рост промпта задан руками.
 *
 * Проверки названы по поломке, которую ловят.
 */

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
const ALL = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }
const config: Config = { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, locale: 'ru' } }

// Язык фраз ставится явно: с 3.8 по умолчанию берётся системный, а проверки
// ниже — про русские формулировки. Без этого они ловили бы локаль машины.
beforeEach(() => {
  setLocale('ru')
})

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-task-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

function fixtures(): void {
  for (const name of ['compact', 'images', 'mcp', 'parallel', 'plain', 'sidechain']) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
}

function cards() {
  return taskRows(db, ALL).map((row) =>
    buildTaskCard(db, { sessionId: row.sessionId, ...ALL }, config)!,
  )
}

describe('buildTaskCard на фикстурах', () => {
  beforeEach(fixtures)

  /**
   * Ловит таймлайн, собранный не по той задаче: точка обязана быть у каждого
   * запроса, посчитанного в шапке, и сумма высот обязана дать итог задачи.
   * Потеряй сборка сессии сабагентов — в шапке будет 276 запросов, в таймлайне
   * 240, и оба числа останутся настоящими.
   */
  it('точка на каждый запрос задачи, сумма точек — итог задачи', () => {
    const all = cards()
    expect(all.length).toBeGreaterThan(0)
    for (const card of all) {
      expect(card.timeline).toHaveLength(card.task.requests)
      expect(card.timeline.reduce((sum, point) => sum + point.tokens, 0)).toBe(
        card.task.tokens.value,
      )
      const stamps = card.timeline.map((point) => point.ts)
      expect(stamps).toEqual([...stamps].sort((left, right) => left - right))
    }
  })

  /**
   * Ловит раскладку инструментов, посчитанную по другому набору вызовов, чем
   * колонка «инструменты» в шапке.
   */
  it('вызовы в строках инструментов сходятся с числом в шапке', () => {
    for (const card of cards()) {
      expect(card.tools.reduce((sum, tool) => sum + tool.calls, 0)).toBe(card.task.toolCalls)
    }
  })

  /**
   * Ловит доли, посчитанные от чего-нибудь другого, и перестановку видов
   * токенов: порядок в контракте — ввод, запись, чтение, вывод, и окно рисует
   * полосу в нём же.
   */
  it('четыре вида токенов в порядке макета, доли — от итога задачи', () => {
    for (const card of cards()) {
      expect(card.tokens.map((slice) => slice.kind)).toEqual([
        'input',
        'cacheWrite',
        'cacheRead',
        'output',
      ])
      const total = card.task.tokens.value
      expect(card.tokens.reduce((sum, slice) => sum + slice.tokens.value, 0)).toBe(total)
      expect(card.tokens.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 10)
      for (const slice of card.tokens) {
        expect(slice.share).toBeCloseTo(slice.tokens.value / total, 12)
      }
    }
  })

  /**
   * Ловит долю, посчитанную от расхода самой задачи или от периода вместо
   * суток: доли всех задач дня обязаны сложиться в единицу.
   */
  it('доли дня складываются в единицу', () => {
    const all = cards()
    const day = buildDayReport(db, ALL)
    expect(all.reduce((sum, card) => sum + card.dayShare, 0)).toBeCloseTo(1, 10)
    for (const card of all) {
      expect(card.dayShare).toBeCloseTo(card.task.tokens.value / day.totals.total.value, 12)
      expect(card.dayShare).toBeLessThanOrEqual(1)
    }
  })

  /**
   * Ловит шапку карточки, собранную вторым похожим запросом: строка ленты и
   * строка карточки — это одна задача, и разойтись им негде.
   */
  it('шапка карточки — та же строка, что в ленте', () => {
    const day = buildDayReport(db, ALL)
    for (const row of day.tasks) {
      const card = buildTaskCard(db, { sessionId: row.sessionId, ...ALL }, config)
      expect(card?.task).toEqual(row)
    }
  })

  /**
   * Ловит выдуманную пустую карточку там, где задачи нет: `null` — это «такой
   * задачи в этом периоде нет», и экран обязан уметь его показать.
   */
  it('нет задачи или нет её в периоде — карточки нет', () => {
    const known = taskRows(db, ALL)[0]!
    expect(buildTaskCard(db, { sessionId: 'нет-такой-сессии', ...ALL }, config)).toBeNull()
    expect(buildTaskCard(db, { sessionId: known.sessionId, from: 0, to: 1 }, config)).toBeNull()
  })

  /**
   * Ловит карточку, собранную за всю задачу поверх ленты, суженной периодом.
   *
   * Задача, начатая до полуночи, попадает в оба дня своими кусками: строка
   * показывает кусок, и карточка обязана показывать его же. На живых логах
   * таких сессий 32 из 578, и на них приходится 21.5% расхода.
   */
  it('период режет карточку ровно так же, как ленту', () => {
    const whole = cards().find((card) => card.task.requests >= 6)!
    const cut = whole.timeline[Math.floor(whole.timeline.length / 2)]!.ts
    const range = { from: 0, to: cut }
    const part = buildTaskCard(db, { sessionId: whole.task.sessionId, ...range }, config)!
    const row = buildDayReport(db, range).tasks.find(
      (task) => task.sessionId === whole.task.sessionId,
    )!

    expect(part.task).toEqual(row)
    expect(part.timeline.length).toBeLessThan(whole.timeline.length)
    expect(part.timeline).toHaveLength(part.task.requests)
    expect(part.timeline.every((point) => point.ts < cut)).toBe(true)
    expect(part.timeline.reduce((sum, point) => sum + point.tokens, 0)).toBe(part.task.tokens.value)
    expect(part.tools.reduce((sum, tool) => sum + tool.calls, 0)).toBe(part.task.toolCalls)
    expect(part.task.tokens.value).toBeLessThan(whole.task.tokens.value)
  })

  /**
   * Ловит список файлов, показанный целиком вместо четырёх, и счёт хвоста,
   * посчитанный по показанному: «+ 8» окно собирает вычитанием, и вычитать оно
   * будет из `total`.
   */
  it('файлы — изменённые, поимённо не больше четырёх, счёт — по всем', () => {
    const card = cards().find((value) => value.files !== undefined)!
    const changed = changedFiles(db, card.task.sessionId, ALL)

    expect(card.files!.total).toBe(changed.length)
    expect(card.files!.paths.length).toBeLessThanOrEqual(4)
    expect(card.files!.paths).toEqual(changed.slice(0, 4).map((file) => file.path))
    expect(cards().filter((value) => value.files === undefined).length).toBeGreaterThan(0)
  })

  /**
   * Ловит «скрыть пути», спрятавшее сам факт правок (3.6). Число затронутых
   * файлов — это расход, а не содержимое: спрячь его — и человек перестанет
   * видеть собственную работу. Прячутся имена, и прячутся в main: уедь путь в
   * окно, настройка называлась бы «не рисовать».
   */
  it('скрытые пути убирают имена, но не число файлов', () => {
    const open = cards().find((value) => value.files !== undefined)!
    const hidden = buildTaskCard(
      db,
      { sessionId: open.task.sessionId, ...ALL },
      { ...DEFAULT_CONFIG, privacy: { hidePrompts: false, hidePaths: true } },
    )!

    expect(hidden.files!.total).toBe(open.files!.total)
    expect(hidden.files!.paths).toEqual([])
    expect(open.files!.paths.length).toBeGreaterThan(0)
  })

  /**
   * Ловит карточку, собранную по одной сессии вместо дерева задачи.
   *
   * Сабагент лежит в индексе отдельной сессией (так и надо, 1.3), а `taskRows`
   * сводит его в корень — то есть шапка уже отчиталась за его запросы. Собери
   * таймлайн и инструменты по одной сессии — и под шапкой «276 запросов»
   * окажется 240 столбиков, причём оба числа останутся настоящими.
   */
  it('сабагент попадает в таймлайн, инструменты и файлы родителя', () => {
    const parent = db.get<{ id: string }>(
      "SELECT id FROM sessions WHERE source_path LIKE '%sidechain.jsonl'",
    )!.id
    const alone = buildTaskCard(db, { sessionId: parent, ...ALL }, config)!
    ingest({
      path: join(claudeDir, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
      provider: 'claude',
      kind: 'subagent',
      parentPath: join(claudeDir, `${parent}.jsonl`),
    })
    const card = buildTaskCard(db, { sessionId: parent, ...ALL }, config)!

    expect(card.timeline.length).toBeGreaterThan(alone.timeline.length)
    expect(card.timeline).toHaveLength(card.task.requests)
    expect(card.timeline.reduce((sum, point) => sum + point.tokens, 0)).toBe(card.task.tokens.value)
    expect(card.tools.reduce((sum, tool) => sum + tool.calls, 0)).toBe(card.task.toolCalls)
    expect(card.task.toolCalls).toBeGreaterThan(alone.task.toolCalls)
  })

  /**
   * Ловит сжатие контекста, оставшееся без пометки: событие есть в логе, и это
   * единственный вид выделения, который на фикстурах вообще встречается.
   */
  it('сжатие контекста помечено причиной и попало в подпись', () => {
    const card = cards().find((value) =>
      value.timeline.some((point) => point.note === 'сжатие контекста'),
    )!
    const marked = card.timeline.filter((point) => point.note !== undefined)

    expect(marked.map((point) => point.note)).toEqual(['сжатие контекста'])
    expect(card.timelineNote).toContain('сжатие контекста')
    expect(card.timelineNote).not.toContain('дороже прочих')
  })
})

/**
 * Модель выделения — на посеянном индексе.
 *
 * На фикстурах дорогих результатов нет: самый большой рост промпта там 3.5k при
 * пороге в 20k, то есть любое правило прошло бы зелёным. Здесь рост задаётся
 * руками, и каждая проверка ломается от своей одной правки в модели.
 */
describe('модель выделения запроса', () => {
  interface Call {
    name: string
    bytes: number
    tokens: number
    basis?: 'measured' | 'split' | 'unknown'
    image?: boolean
    path?: string
    /** `read` — путь только для подсказки, `write` — ещё и в список файлов. */
    action?: 'read' | 'write'
  }
  interface Spec {
    tokens: number
    compacted?: boolean
    context?: number
    calls?: Call[]
  }

  function seed(specs: readonly Spec[]): void {
    db.run(
      `INSERT INTO sessions (id, provider, source_path, cwd, project, model, title,
         started_at, ended_at)
       VALUES ('seed', 'claude', '/seed', '/proj', 'proj', 'Opus 5', 'посев', 0, ?)`,
      specs.length * 1000,
    )
    specs.forEach((spec, seq) => {
      db.run(
        `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
           cache_write, cache_read, context_tokens, origin)
         VALUES ('seed', ?, ?, ?, 'm', 0, 0, 0, ?, ?, 'log')`,
        seq,
        `r${seq}`,
        seq * 1000,
        spec.tokens,
        spec.context ?? 0,
      )
      if (spec.compacted === true) {
        db.run('UPDATE requests SET compacted = 1 WHERE session_id = ? AND seq = ?', 'seed', seq)
      }
      ;(spec.calls ?? []).forEach((call, idx) => {
        db.run(
          `INSERT INTO tool_calls (session_id, seq, idx, tool_use_id, name, kind,
             result_bytes, marginal_tokens, marginal_basis, has_image)
           VALUES ('seed', ?, ?, ?, ?, 'builtin', ?, ?, ?, ?)`,
          seq,
          idx,
          `t${seq}-${idx}`,
          call.name,
          call.bytes,
          call.tokens,
          call.basis ?? 'measured',
          call.image === true ? 1 : 0,
        )
        if (call.path !== undefined) {
          db.run(
            `INSERT INTO tool_files (session_id, seq, idx, path, action)
             VALUES ('seed', ?, ?, ?, ?)`,
            seq,
            idx,
            call.path,
            call.action ?? 'read',
          )
        }
      })
    })
  }

  function timeline(): TimelinePoint[] {
    return buildTaskCard(db, { sessionId: 'seed', ...ALL }, config)!.timeline
  }

  /** Пять рядовых запросов с копеечными результатами — фон для выброса. */
  const quiet = (count: number, name = 'Grep'): Spec[] =>
    Array.from({ length: count }, () => ({
      tokens: 100_000,
      calls: [{ name, bytes: 2000, tokens: 700 }],
    }))

  /**
   * Ловит пометку, поставленную запросу, который сделал вызов, вместо того, кто
   * за него заплатил.
   *
   * Результат инструмента приезжает в промпт **следующего** запроса — на этом
   * стоит вся атрибуция 1.6. Пометь мы вызвавшего — красным окажется столбик
   * обычной высоты, а взлетевший рядом останется без объяснения.
   */
  it('красит запрос, оплативший рост промпта, а не тот, что сделал вызов', () => {
    seed([
      ...quiet(4),
      {
        tokens: 120_000,
        calls: [{ name: 'Read', bytes: 400_000, tokens: 150_000, path: '/proj/bench/runner.py' }],
      },
      { tokens: 300_000 },
      ...quiet(4),
    ])
    const points = timeline()

    expect(points[4]!.note).toBeUndefined()
    expect(points[5]!.note).toBe('большой результат Read — bench/runner.py — 150k в промпт')
    expect(points.filter((point) => point.note !== undefined)).toHaveLength(1)
  })

  /**
   * Ловит порог, снятый до «просто больше медианы»: пятикратное превышение
   * копеечного фона — это всё ещё копейки, а красный столбик про них говорит
   * то же, что красный столбик про мегабайт.
   */
  it('не выделяет крупный по мерке задачи, но мелкий по абсолютной величине рост', () => {
    seed([
      ...quiet(4),
      { tokens: 120_000, calls: [{ name: 'Read', bytes: 40_000, tokens: 19_999 }] },
      { tokens: 140_000 },
      ...quiet(4),
    ])

    expect(timeline().every((point) => point.note === undefined)).toBe(true)
  })

  /**
   * Ловит выделение по абсолютному числу без оглядки на задачу: там, где
   * двадцатитысячные результаты — обычное дело, выделено оказалось бы всё.
   */
  it('не выделяет рост, обычный для этой задачи', () => {
    const busy: Spec[] = Array.from({ length: 8 }, () => ({
      tokens: 300_000,
      calls: [{ name: 'Read', bytes: 100_000, tokens: 40_000 }],
    }))
    seed(busy)

    expect(timeline().every((point) => point.note === undefined)).toBe(true)
  })

  /**
   * Ловит причину, названную по поделённым токенам вместо измеренных байтов.
   *
   * При `basis: 'split'` вклад вызова получается делением одной дельты между
   * параллельными вызовами по их же байтам (1.6) — то есть «самый дорогой» там
   * определён с точностью до способа дележа. Байты измерены всегда, и имя
   * инструмента в подсказке обязано приходить от них.
   */
  it('называет инструмент по самому объёмному результату', () => {
    seed([
      ...quiet(4),
      {
        tokens: 120_000,
        calls: [
          { name: 'Grep', bytes: 1000, tokens: 90_000, basis: 'split' },
          {
            name: 'Read',
            bytes: 500_000,
            tokens: 60_000,
            basis: 'split',
            path: '/proj/src/app.ts',
          },
        ],
      },
      { tokens: 320_000 },
      ...quiet(4),
    ])

    expect(timeline()[5]!.note).toBe('большой результат Read — src/app.ts — 150k в промпт')
  })

  /**
   * Ловит инструмент, названный виноватым при размазанном росте: у пятнадцати
   * параллельных вызовов виноват не один из них, а то, что их пятнадцать.
   */
  it('не называет инструмент, когда ни один результат не перевесил остальные', () => {
    seed([
      ...quiet(4),
      {
        tokens: 120_000,
        calls: [
          { name: 'Bash', bytes: 100_000, tokens: 40_000, basis: 'split' },
          { name: 'Bash', bytes: 100_000, tokens: 40_000, basis: 'split' },
          { name: 'Grep', bytes: 100_000, tokens: 40_000, basis: 'split' },
        ],
      },
      { tokens: 300_000 },
      ...quiet(4),
    ])

    expect(timeline()[5]!.note).toBe('3 результата инструментов сразу — 120k в промпт')
  })

  /**
   * Ловит потерянные картинки: они плотнее текста в тринадцать раз (факт 1), и
   * это единственное объяснение, которое человек не выведет из имени
   * инструмента.
   */
  it('называет картинки причиной, когда они были в результате', () => {
    seed([
      ...quiet(4),
      {
        tokens: 120_000,
        calls: [{ name: 'Read', bytes: 5000, tokens: 60_000, image: true }],
      },
      { tokens: 200_000 },
      ...quiet(4),
    ])

    expect(timeline()[5]!.note).toBe(
      '1 картинка в результате — плотнее текста в тринадцать раз, 60k в промпт',
    )
  })

  /**
   * Ловит выделение строки инструмента по сумме вместо цены вызова: сто дешёвых
   * `Bash` наберут больше любого другого инструмента просто числом, и ругать за
   * это значит ругать за работу.
   */
  it('выделяет инструмент по цене вызова, а не по общей сумме', () => {
    seed([
      ...Array.from({ length: 20 }, () => ({
        tokens: 100_000,
        calls: [{ name: 'Bash', bytes: 3000, tokens: 1000 }],
      })),
      {
        tokens: 100_000,
        calls: [{ name: 'view_image', bytes: 5000, tokens: 30_000, image: true }],
      },
      { tokens: 100_000 },
    ])
    const tools = buildTaskCard(db, { sessionId: 'seed', ...ALL }, config)!.tools

    expect(tools.find((tool) => tool.key === 'Bash')!.note).toBeUndefined()
    expect(tools.find((tool) => tool.key === 'Bash')!.marginal.value).toBeGreaterThan(0)
    expect(tools.find((tool) => tool.key === 'view_image')!.note).toContain('с картинками')
  })

  /**
   * Ловит список файлов, собранный за всю задачу под лентой, суженной периодом:
   * у карточки на 40M оказался бы список правок за оба дня.
   */
  it('период режет и список файлов', () => {
    seed([
      {
        tokens: 10,
        calls: [{ name: 'Edit', bytes: 10, tokens: 1, path: '/proj/a.ts', action: 'write' }],
      },
      {
        tokens: 10,
        calls: [{ name: 'Edit', bytes: 10, tokens: 1, path: '/proj/b.ts', action: 'write' }],
      },
      {
        tokens: 10,
        calls: [{ name: 'Edit', bytes: 10, tokens: 1, path: '/proj/c.ts', action: 'write' }],
      },
    ])
    const whole = buildTaskCard(db, { sessionId: 'seed', ...ALL }, config)!
    const part = buildTaskCard(db, { sessionId: 'seed', from: 0, to: 2000 }, config)!

    expect(whole.files).toEqual({ total: 3, paths: ['a.ts', 'b.ts', 'c.ts'] })
    expect(part.files).toEqual({ total: 2, paths: ['a.ts', 'b.ts'] })
  })

  /**
   * Ловит точность строки, выданную за измерение: через дележ проходит 33%
   * расхода у Claude и 72% у Codex, а у вызовов последнего запроса стоимости
   * нет вовсе — и это разные оговорки.
   */
  it('помечает оценкой и делёж, и неизмеренное', () => {
    seed([
      { tokens: 100_000, calls: [{ name: 'Read', bytes: 1000, tokens: 500 }] },
      {
        tokens: 100_000,
        calls: [
          { name: 'Grep', bytes: 1000, tokens: 300, basis: 'split' },
          { name: 'Grep', bytes: 1000, tokens: 300, basis: 'split' },
        ],
      },
      { tokens: 100_000, calls: [{ name: 'Bash', bytes: 0, tokens: 0, basis: 'unknown' }] },
    ])
    const tools = buildTaskCard(db, { sessionId: 'seed', ...ALL }, config)!.tools
    const find = (key: string) => tools.find((tool) => tool.key === key)!

    expect(find('Read').marginal.confidence).toBe('exact')
    expect(find('Grep').marginal.confidence).toBe('estimate')
    expect(find('Grep').marginal.caveat).toContain('поделена')
    expect(find('Bash').marginal.confidence).toBe('estimate')
    expect(find('Bash').marginal.caveat).toContain('измерить нечем')
  })
})

/**
 * Подпись под таймлайном и наблюдение под раскладкой — чистые функции, вход у
 * них уже посчитан. Проверяются словами, потому что словами и врут.
 */
describe('фразы карточки', () => {
  const point = (tokens: number, note?: string): TimelinePoint =>
    note === undefined ? { ts: 0, tokens } : { ts: 0, tokens, note }

  /**
   * Ловит подпись, склеенную одним шаблоном на все случаи: «дороже прочих» про
   * сжатие контекста — неправда, оно как раз удешевляет следующий запрос.
   */
  it('подписывает выделенное по тому, чем оно выделено', () => {
    expect(timelineNote([point(10), point(700_000, 'большой результат Read')], 'ru')).toBe(
      '1 запрос дороже прочих — 700k',
    )
    expect(
      timelineNote(
        [point(700_000, 'большой результат Read'), point(800_000, 'большой результат Read')],
        'ru',
      ),
    ).toBe('2 запроса дороже прочих — 1,5M вместе')
    expect(
      timelineNote([point(1000, 'сжатие контекста'), point(2000, 'сжатие контекста')], 'ru'),
    ).toBe('2 сжатия контекста — 3k вместе')
    expect(
      timelineNote(
        [point(1000, 'сжатие контекста'), point(700_000, 'большой результат Read')],
        'ru',
      ),
    ).toBe('2 запроса выделены — 701k вместе')
    expect(timelineNote([point(10), point(20)], 'ru')).toBeUndefined()
  })

  /**
   * Ловит наблюдение, сочинённое там, где чтения кэша почти нет, и молчание
   * там, где оно съело задачу целиком.
   */
  it('говорит про чтение кэша только когда оно и правда велико', () => {
    const requests = (count: number, context: number) =>
      Array.from({ length: count }, (_, index) => ({
        sessionId: 's',
        seq: index,
        ts: index,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 10,
        total: 10,
        contextTokens: index === 0 ? context : 1000,
        compacted: false,
      }))

    expect(note(requests(3, 241_000), 900, 1000, 'ru')).toBe(
      'Кэш перечитывался 3 раза — контекст вырастал до 241k.',
    )
    expect(note(requests(3, 241_000), 400, 1000, 'ru')).toBeUndefined()
    expect(note(requests(1, 241_000), 900, 1000, 'ru')).toBeUndefined()
    expect(note([], 0, 0, 'ru')).toBeUndefined()
  })
})
