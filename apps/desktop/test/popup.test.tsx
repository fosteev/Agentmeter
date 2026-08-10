import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatTokens as coreFormat } from '@agentmeter/core/format'
import type { TraySnapshot } from '@agentmeter/ipc'
import { Popup } from '../src/renderer/components/Popup.tsx'
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

  /** Ловит потерянные состояния: все три строки макета должны нарисоваться. */
  it('рисует каждого агента снимка', () => {
    for (const agent of snapshot.agents) {
      expect(markup).toContain(agent.project)
    }
    expect(markup).toContain('ждёт ответа')
    expect(markup).toContain('завершился')
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
