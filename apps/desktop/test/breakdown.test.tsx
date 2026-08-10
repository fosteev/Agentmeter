import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, openDb, type Db, type SourceFile } from '@agentmeter/core'
import type { SpendScreen } from '@agentmeter/ipc'
import { buildSpendScreen, rereadTimes } from '../src/main/breakdown.ts'
import { buildDayReport } from '../src/main/day.ts'
import { BreakdownTab } from '../src/renderer/components/BreakdownTab.tsx'
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

describe('BreakdownTab', () => {
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
