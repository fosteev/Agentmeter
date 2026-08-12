import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  Children,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatTokens as coreFormat } from '@agentmeter/core/format'
import type { TraySnapshot } from '@agentmeter/ipc'
import { AgentRow } from '../src/renderer/components/AgentRow.tsx'
import { Popup } from '../src/renderer/components/Popup.tsx'
import { PopupLimit } from '../src/renderer/components/PopupLimit.tsx'
import { formatTokens, setLocale } from '../src/renderer/format.ts'

/**
 * Разметка попапа на фикстуре. Браузер не запускается: строка статической
 * разметки отвечает на все вопросы приёмки, а числа в ней сверяются с макетом.
 *
 * Вход — `fixtures/popup/snapshot.json`, тот же, что пришит к контракту тестом
 * `packages/ipc/test/fixture.test.ts`. Придумывать свои данные нельзя: в
 * фикстуре намеренно лежит окно без процента, оценка, точное число, агент с
 * `approximate` и агент с `endedAt` — без них половина проверок зелена на любом
 * коде.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url))
const snapshot = JSON.parse(
  readFileSync(`${root}fixtures/popup/snapshot.json`, 'utf8'),
) as TraySnapshot

setLocale('ru')
const markup = renderToStaticMarkup(<Popup snapshot={snapshot} now={snapshot.at + 2000} />)

describe('попап на фикстуре', () => {
  /**
   * Ловит единственную ошибку, ради которой продукт затевался: оценку, выданную
   * за факт. У Claude до калибровки веса `cache_read` (этап 1.9) процента нет
   * вовсе — и это норма, которую надо показать словами, а не нулём.
   */
  it('незнание не показано нулём', () => {
    const unknown = snapshot.limits.filter((window) => window.usedPercent === null)
    expect(unknown.length).toBeGreaterThan(0)

    // Ни числа «0%», ни заливки: пустая полоса читается как «израсходовано
    // нисколько», а это неправда — мы просто не знаем.
    expect(markup).not.toContain('>0%<')

    // Заливки сверяются с процентами поимённо. «Нет ширины 0%» мало: неизвестный
    // процент, дошедший до стиля, даёт не ноль, а мусор вроде `width:null%` —
    // полоса рисуется, а проверка молчит. «Их столько же и они не нули» тоже
    // мало: константа в ширине прошла бы насквозь, а показать чужой процент —
    // ровно то, ради чего затевался 1.8.
    const fills = [...markup.matchAll(/width:\s*([^;"]+)%/g)].map(([, value]) => Number(value))
    const known = snapshot.limits
      .map((window) => window.usedPercent)
      .filter((percent): percent is number => percent !== null)
    expect([...fills].sort((a, b) => a - b)).toEqual([...known].sort((a, b) => a - b))

    for (const window of unknown) {
      expect(markup).toContain(window.unavailableReason)
    }
    // Прочерк вместо числа — ровно столько раз, сколько неизвестных окон.
    expect(markup.split('>—<').length - 1).toBe(unknown.length)
  })

  /**
   * Ловит обе ошибки разом: точное число Codex, показанное как оценка, и оценку
   * Claude, показанную как точную. Штриховка и знак «≈» — это не украшение, а
   * единственное, чем они различаются на экране.
   */
  it('оценка отмечена, точное — нет', () => {
    const hatched = snapshot.limits.filter((w) => !w.exact && w.usedPercent !== null)
    const solid = snapshot.limits.filter((w) => w.exact && w.usedPercent !== null)
    expect(hatched.length).toBeGreaterThan(0)
    expect(solid.length).toBeGreaterThan(0)

    for (const window of hatched) {
      expect(markup).toContain(`≈${Math.round(window.usedPercent!)}%`)
    }
    for (const window of solid) {
      expect(markup).toContain(`>${Math.round(window.usedPercent!)}%<`)
      expect(markup).not.toContain(`≈${Math.round(window.usedPercent!)}%`)
    }
    // Штриховка ровно у оценок: repeating-linear-gradient рисуется только там.
    expect(markup.split('repeating-linear-gradient').length - 1).toBe(hatched.length)
  })

  /**
   * Ловит расхождение попапа с `agentmeter live` на одной машине: сессия с
   * восстановленными запросами (1.3) обязана показываться со знаком, иначе два
   * числа противоречат друг другу молча.
   */
  it('восстановленный расход помечен знаком ≈', () => {
    const approximate = snapshot.agents.filter((agent) => agent.approximate)
    expect(approximate.length).toBeGreaterThan(0)
    for (const agent of approximate) {
      expect(markup).toContain(`≈${formatTokens(agent.tokens)}`)
    }
    for (const agent of snapshot.agents.filter((a) => !a.approximate)) {
      expect(markup).not.toContain(`≈${formatTokens(agent.tokens)}`)
    }
    // Сумма за сутки восстановлена (1.3) — та же пометка в подвале.
    expect(markup).toContain(`≈${formatTokens(snapshot.today.total.value)}`)
  })

  /**
   * Ловит попап, который считает сам. Число в подвале обязано приезжать готовым
   * из `DayTotals.total`: сложи его в окне — и оно разойдётся с CLI, а какое из
   * двух настоящее, пользователю никто не скажет.
   */
  it('сумма за сутки — из снимка, а не сложена в окне', () => {
    expect(markup).toContain(formatTokens(snapshot.today.total.value))
    const sum =
      snapshot.today.input.value +
      snapshot.today.output.value +
      snapshot.today.cacheWrite.value +
      snapshot.today.cacheRead.value
    expect(snapshot.today.total.value).toBe(sum)
  })

  /** Ловит потерянные состояния: все четыре строки должны нарисоваться. */
  it('рисует каждого агента снимка', () => {
    for (const agent of snapshot.agents) {
      expect(markup).toContain(agent.project)
    }
    expect(markup).toContain('ждёт ответа')
    expect(markup).toContain('молчит')
    expect(markup).toContain('завершился')
  })
})

/**
 * Заполнение контекстного окна (2.6). В макете его нет, поэтому проверяется не
 * совпадение с эталоном, а два свойства, ради которых этап делался.
 */
/**
 * Подпись и кнопка над блоком лимитов (6.3).
 *
 * Проверяется здесь то, что легко потерять при правке вёрстки: слово «оценка»
 * обязано исчезать ровно тогда, когда исчезает оценка, а кнопка, уходящая в
 * сеть, — появляться только с разрешения человека. Попап открывается одним
 * движением мыши, в том числе на общем экране, и «спросить Anthropic» без
 * включённой настройки было бы согласием по умолчанию.
 */
describe('подпись над лимитами', () => {
  const withSource = (source: TraySnapshot['limitsSource'], exact = false): string => {
    const next: TraySnapshot = {
      ...snapshot,
      limitsSource: source,
      limits: snapshot.limits.map((window) =>
        window.provider === 'claude' ? { ...window, exact, usedPercent: exact ? 37 : null } : window,
      ),
    }
    return renderToStaticMarkup(<Popup snapshot={next} now={next.at + 2000} />)
  }

  it('источник выключен — всё как до этапа: «оценка» и никакой кнопки', () => {
    const html = withSource({ enabled: false })
    expect(html).toContain('оценка')
    expect(html).not.toContain('data-limits-action="ask"')
  })

  it('источник включён — есть кнопка и возраст ответа', () => {
    const html = withSource({ enabled: true, askedAt: snapshot.at - 120_000 })
    expect(html).toContain('data-limits-action="ask"')
    expect(html).toContain('Anthropic · 2 мин назад')
  })

  it('включён, но не спрашивали — так и написано, а не «0 с назад»', () => {
    expect(withSource({ enabled: true })).toContain('не спрашивали')
  })

  it('все проценты от провайдера — слова «оценка» нет', () => {
    // Окна Codex в фикстуре точны сами по себе, окна Claude здесь помечены
    // точными: оценке взяться неоткуда, и подпись обязана замолчать.
    const html = withSource({ enabled: true, askedAt: snapshot.at }, true)
    expect(html).not.toContain('оценка')
  })

  it('внутри окна ограничения кнопка мертва и причина названа', () => {
    const html = withSource({ enabled: true, retryAt: snapshot.at + 300_000 })
    expect(html).toContain('disabled')
    expect(html).toContain('ждём')
  })
})

describe('указатель контекста в строке агента', () => {
  // background:linear-gradient(to top, var(--claude) 0 89%, var(--s2) 89% 100%)
  const GAUGE = /linear-gradient\(to top, var\(--[a-z0-9]+\) 0 (\d+)%, var\(--s2\) (\d+)% 100%\)/g
  const gauges = [...markup.matchAll(GAUGE)].map(([, from, to]) => ({
    from: Number(from),
    to: Number(to),
  }))

  /**
   * Ловит выдуманное заполнение. Указатель обязан появиться ровно у тех
   * агентов, у которых размер окна есть, и показать их долю: у Claude окна нет
   * ни в логе, ни в имени модели, и нарисованная там полоска — это доля,
   * посчитанная от числа, которого никто не знает.
   */
  it('полоска только там, где окно известно, и длиной ровно в остаток', () => {
    const known = snapshot.agents.filter((agent) => agent.context !== undefined)
    expect(known.length).toBeGreaterThan(0)
    expect(snapshot.agents.some((agent) => agent.context === undefined)).toBe(true)
    expect(gauges.length).toBe(known.length)

    // Середина размытой границы — то же число, что резкая: размывается
    // положение, а не доля.
    const middles = gauges.map((gauge) => (gauge.from + gauge.to) / 2).sort((a, b) => a - b)
    const expected = known
      .map((agent) => Math.round((1 - agent.context!.fill) * 100))
      .sort((a, b) => a - b)
    expect(middles).toEqual(expected)
  })

  /**
   * Ловит оценку, выданную за измерение, — тот же класс ошибки, что штриховка
   * у полосы лимита. Размер окна Codex написал провайдер, размер окна Claude мы
   * вывели из наблюдений, и на экране это обязано различаться.
   */
  it('у выведенного размера окна граница размыта, у написанного провайдером — резкая', () => {
    const exact = snapshot.agents.filter((a) => a.context?.confidence === 'exact')
    const estimate = snapshot.agents.filter((a) => a.context?.confidence === 'estimate')
    expect(exact.length).toBeGreaterThan(0)
    expect(estimate.length).toBeGreaterThan(0)

    expect(gauges.filter((gauge) => gauge.from === gauge.to).length).toBe(exact.length)
    expect(gauges.filter((gauge) => gauge.from < gauge.to).length).toBe(estimate.length)
  })

  /**
   * Ловит полоску без объяснения. Три пикселя молча — это украшение: число,
   * его единицы и природа знаменателя живут только в подсказке, и потеряй её
   * попап, оценку от измерения отличить будет нечем вовсе.
   */
  it('подсказка называет долю, оба числа и природу знаменателя', () => {
    for (const agent of snapshot.agents) {
      const context = agent.context
      if (context === undefined) continue
      const sign = context.confidence === 'exact' ? '' : '≈'
      expect(markup).toContain(
        `контекст ${sign}${Math.round(context.fill * 100)}% · ${formatTokens(context.used)} из ${sign}${formatTokens(context.window)}`,
      )
      if (context.caveat !== undefined) expect(markup).toContain(context.caveat)
    }
  })
})

describe('числа в CLI и в попапе', () => {
  /**
   * Ловит возврат второго форматтера с зашитой локалью — расхождение «344.9M»
   * против «344,9M» на одной машине. Проверяется именно тот путь, которым
   * числа идут в окно: обёртка рендерера против общего форматтера ядра.
   */
  it('formatTokens даёт одну строку обоим на одной локали', () => {
    const values = [0, 999, 1000, 14_800, 38_000, 344_900_000, 1_500_000_000]
    for (const locale of ['ru', 'en-US']) {
      setLocale(locale)
      for (const value of values) {
        expect(formatTokens(value)).toBe(coreFormat(value, locale))
      }
    }
    setLocale('ru')
  })

  /** Ловит суффикс, уехавший от макета: в макете «38k» и «14.8k», не «38K». */
  it('суффикс тысяч строчный, как в макете', () => {
    setLocale('en-US')
    expect(formatTokens(38_000)).toBe('38k')
    expect(formatTokens(14_800)).toBe('14.8k')
    expect(formatTokens(344_900_000)).toBe('344.9M')
    setLocale('ru')
  })

  /**
   * Ловит возвращённый второй форматтер: в рендерере не должно остаться своей
   * арифметики масштаба и своей локали.
   */
  it('в рендерере нет второго форматтера', () => {
    const dir = fileURLToPath(new URL('../src/renderer', import.meta.url))
    const walk = (path: string): string[] =>
      readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(`${path}/${entry.name}`)
          : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
            ? [readFileSync(`${path}/${entry.name}`, 'utf8')]
            : [],
      )
    const code = walk(dir).join('\n')
    expect(code).not.toMatch(/1_000_000_000|1000000000/)
    expect(code).not.toMatch(/['"]en-US['"]/)
  })
})

describe('длинный список агентов', () => {
  /**
   * Ловит список, вытолкнувший лимиты и подвал за нижний край: высота попапа
   * 600 и не тянется, а открытых чатов бывает и десять.
   *
   * Проверяется вложенностью, а не пикселями — браузера здесь нет и высоту
   * никто не считает. Но вопрос решается целиком: строки агентов обязаны
   * лежать внутри прокручиваемого блока, а полосы лимита — снаружи него.
   * Скролл вокруг всего разом (и лимитов заодно) — та же болезнь: до полос
   * снова придётся докручивать.
   */
  it('строки уходят под скролл, лимиты остаются на месте', () => {
    const many: TraySnapshot = {
      ...snapshot,
      agents: Array.from({ length: 12 }, (_, i) => ({
        ...snapshot.agents[0]!,
        sessionId: `session-${i}`,
      })),
    }
    const tree = Popup({ snapshot: many, now: many.at + 2000 })

    const scrollers = elements(tree).filter((node) => node.props.style?.overflowY === 'auto')
    expect(scrollers.length).toBe(1)
    const inside = elements(scrollers[0]!)
    expect(inside.filter((node) => node.type === AgentRow).length).toBe(12)
    expect(inside.filter((node) => node.type === PopupLimit)).toEqual([])

    // Ни одна строка не потеряна по дороге: скролл, а не обрезание.
    const all = elements(tree)
    expect(all.filter((node) => node.type === AgentRow).length).toBe(12)
    expect(all.filter((node) => node.type === PopupLimit).length).toBe(many.limits.length)
  })
})

interface NodeProps {
  children?: ReactNode
  style?: CSSProperties
}

/** Элемент и всё, что под ним, одним списком. */
function elements(node: ReactNode): Array<ReactElement<NodeProps>> {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<NodeProps>
  return [
    element,
    ...Children.toArray(element.props.children).flatMap((child) => elements(child)),
  ]
}

describe('в сеть за вёрсткой не ходим', () => {
  /**
   * Ловит шрифты, уехавшие обратно на Google Fonts: офлайн и приватность,
   * заявленные в настройках, отвалятся молча и обнаружатся только без
   * интернета. Проверяется собранный бандл, а не исходники, — ссылка может
   * приехать из зависимости.
   */
  it('в собранном бандле нет ни одной внешней загрузки', () => {
    const web = fileURLToPath(new URL('../dist/web', import.meta.url))
    const walk = (path: string): Array<{ name: string; text: string }> =>
      readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(`${path}/${entry.name}`)
          : /\.(html|js|css)$/.test(entry.name)
            ? [
                {
                  name: `${path}/${entry.name}`,
                  text: readFileSync(`${path}/${entry.name}`, 'utf8'),
                },
              ]
            : [],
      )
    const files = walk(web)
    // Пустой список значил бы, что проверять нечего и она зелена всегда.
    expect(files.length).toBeGreaterThan(0)

    /**
     * Ищется загрузка, а не упоминание. Голый `https://` в бандле есть и будет:
     * React зашивает ссылки на свою документацию в тексты ошибок, и падать на
     * них значило бы держать проверку, которую придётся отключить в первый же
     * день. Ловим то, что браузер действительно пойдёт качать: `url(...)` в
     * стилях, `src`/`href` в разметке, `@import` и явную сетевую загрузку из
     * кода.
     */
    const LOADS = [
      /url\(\s*['"]?https?:/i,
      /(?:src|href)\s*=\s*['"]https?:/i,
      /@import\s+(?:url\()?\s*['"]https?:/i,
      /(?:fetch|importScripts|WebSocket|XMLHttpRequest)\s*\(\s*['"`]https?:/i,
      /['"`]https?:\/\/[^'"`]+\.(?:woff2?|ttf|otf|css|png|jpe?g|svg|gif|webp)['"`]/i,
    ]
    const withLoads = files
      .filter((file) => LOADS.some((rule) => rule.test(file.text)))
      .map((file) => file.name.slice(web.length + 1))
    expect(withLoads).toEqual([])
  })
})
