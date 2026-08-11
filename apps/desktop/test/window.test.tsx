import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Provider } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import { Window } from '../src/renderer/components/Window.tsx'
import { WindowHeader } from '../src/renderer/components/WindowHeader.tsx'
import { WindowTabs, type WindowTab } from '../src/renderer/components/WindowTabs.tsx'
import { setLocale } from '../src/renderer/format.ts'
import { initialTab, tabPlaceholder } from '../src/renderer/window-main.tsx'

const root = fileURLToPath(new URL('../../../', import.meta.url))

function fixture(name: 'snapshot' | 'empty'): TraySnapshot {
  return JSON.parse(readFileSync(`${root}fixtures/popup/${name}.json`, 'utf8')) as TraySnapshot
}

const snapshot = fixture('snapshot')
const empty = fixture('empty')
setLocale('ru')

function headerMarkup(value: TraySnapshot): string {
  return renderToStaticMarkup(
    <WindowHeader snapshot={value} activeTab="today" onTabChange={() => undefined} />,
  )
}

interface ButtonProps {
  children?: ReactNode
  onClick?: () => void
}

function findButtons(node: ReactNode): Array<ReactElement<ButtonProps>> {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<ButtonProps>
  const own = element.type === 'button' ? [element] : []
  return [
    ...own,
    ...Children.toArray(element.props.children).flatMap((child) => findButtons(child)),
  ]
}

describe('каркас главного окна на контрактных фикстурах', () => {
  /** Ловит потерянную вкладку или две одновременно подсвеченные активными. */
  it('вкладок ровно четыре, активная ровно одна', () => {
    const html = renderToStaticMarkup(<WindowTabs active="today" onChange={() => undefined} />)
    expect(html.split('<button').length - 1).toBe(4)
    expect(html.split('aria-current="page"').length - 1).toBe(1)
    for (const label of ['Сегодня', 'Развёртка', 'История', 'Настройки']) {
      expect(html).toContain(`>${label}</button>`)
    }
  })

  /**
   * Ловит вкладку с фоном от Chromium.
   *
   * У `button` без объявленного фона браузер рисует свой `buttonface` —
   * светло-серый и в тёмной теме, — и невыбранные вкладки оказываются
   * подсвечены сильнее выбранной. Подсветка ровно одна, и это `--s2`.
   */
  it('фон вкладки объявлен, а не оставлен браузеру', () => {
    const html = renderToStaticMarkup(<WindowTabs active="today" onChange={() => undefined} />)

    expect(html.split('background:transparent').length - 1).toBe(3)
    expect(html.split('background:var(--s2)').length - 1).toBe(1)
  })

  /** Ловит переключатель, который меняет подсветку, но оставляет прежний экран. */
  it('переключение вкладки меняет честную заглушку', () => {
    let active: WindowTab = 'today'
    const buttons = findButtons(WindowTabs({ active, onChange: (next) => (active = next) }))
    buttons.find((button) => button.props.children === 'Развёртка')!.props.onClick?.()

    const html = renderToStaticMarkup(
      <Window snapshot={snapshot} activeTab={active} onTabChange={() => undefined}>
        {tabPlaceholder(active)}
      </Window>,
    )
    expect(active).toBe('breakdown')
    expect(html).toContain('этот экран появится в 4.2')
    expect(html).not.toContain('этот экран появится в 3.2')
  })

  /** Ловит неизвестный процент, показанный нулём или пустой полосой без причины. */
  it('неизвестный процент показан прочерком без полосы и с причиной', () => {
    const unknown: TraySnapshot = {
      ...snapshot,
      limits: snapshot.limits.filter((limit) => limit.usedPercent === null),
    }
    const html = headerMarkup(unknown)
    const reason = unknown.limits[0]!.unavailableReason
    expect(html).toContain('CL —')
    expect(html).not.toContain('>0%<')
    expect(html).not.toMatch(/width:\s*[^;"']+%/)
    expect(html).toContain(reason)
  })

  /** Ловит оценочный лимит без штриховки/≈ и точный лимит, ошибочно помеченный оценкой. */
  it('оценочный процент отмечен, точный — нет', () => {
    const html = headerMarkup(snapshot)
    expect(html).toContain('CL ≈68%')
    expect(html).toContain('CX 5%')
    expect(html).not.toContain('CX ≈5%')
    expect(html.split('repeating-linear-gradient').length - 1).toBe(1)
  })

  /**
   * Ловит константу в заливке и выбор не самого большого известного окна.
   *
   * Второе на фикстуре как есть не проверяется: там у каждого провайдера ровно
   * одно окно с известным процентом, и максимум из одного числа берёт любой
   * код, включая минимум. Поэтому у claude здесь дорисовано второе окно —
   * недельное, вдвое дешевле пятичасового. В шапку обязано попасть то, что
   * ближе к потолку: иначе человек увидит спокойные 34% в тот момент, когда до
   * упора осталось 32.
   */
  it('ширина заливки равна наибольшему известному проценту провайдера', () => {
    for (const provider of ['claude', 'codex'] as const satisfies readonly Provider[]) {
      const own = snapshot.limits.filter((limit) => limit.provider === provider)
      const loudest = own.find((limit) => limit.usedPercent !== null)!
      const limits = [
        ...own,
        { ...loudest, kind: 'weekly' as const, usedPercent: loudest.usedPercent! / 2 },
      ]
      const known = limits
        .map((limit) => limit.usedPercent)
        .filter((percent): percent is number => percent !== null)
      expect(known.length, 'проверять максимум из одного числа бессмысленно').toBeGreaterThan(1)

      const html = headerMarkup({ ...snapshot, limits })
      const fills = [...html.matchAll(/width:\s*([^;"']+)%/g)].map(([, value]) => Number(value))
      expect(fills).toEqual([Math.max(...known)])
    }
  })

  /** Ловит завершившуюся сессию, ошибочно посчитанную активной. */
  it('число активных не считает завершившихся', () => {
    const html = headerMarkup(snapshot)
    const active = snapshot.agents.filter((agent) => agent.state !== 'done').length
    expect(html).toContain(`${active} активных`)
    expect(html).not.toContain(`${snapshot.agents.length} активных`)
  })

  /**
   * Ловит окно, открывшееся не на той вкладке.
   *
   * Вкладку выбирает тот, кто окно поднял, и едет она параметром адреса: попап
   * зовёт `window:open` с `settings` с экрана ошибки. Не читайся параметр —
   * человек попадёт на ленту и решит, что кнопка не работает.
   */
  it('вкладка берётся из адреса, незнакомая — лента', () => {
    expect(initialTab('?tab=settings')).toBe('settings')
    expect(initialTab('?tab=breakdown')).toBe('breakdown')
    expect(initialTab('')).toBe('today')
    expect(initialTab('?tab=такой-нет')).toBe('today')
  })

  /**
   * Ловит порядок провайдеров, унаследованный от данных: окна лимита приезжают
   * в порядке индекса, и CL с CX менялись бы местами от снимка к снимку.
   */
  it('порядок провайдеров в шапке задан, а не взят из данных', () => {
    // Обе раскладки, а не одна: разверни фикстуру, у которой Codex и так первый,
    // — и проверка пройдёт на коде, который просто повторяет порядок данных.
    const codexFirst = [...snapshot.limits].sort((left, right) =>
      left.provider === right.provider ? 0 : left.provider === 'codex' ? -1 : 1,
    )
    for (const limits of [codexFirst, [...codexFirst].reverse()]) {
      const html = headerMarkup({ ...snapshot, limits })
      expect(html.indexOf('CL')).toBeGreaterThanOrEqual(0)
      expect(html.indexOf('CX')).toBeGreaterThanOrEqual(0)
      expect(html.indexOf('CL')).toBeLessThan(html.indexOf('CX'))
    }
  })

  /**
   * Ловит штриховку с вшитым цветом: она помечает точность, шкала — тревогу, и
   * оценка на 92% не должна выглядеть спокойной.
   */
  it('штриховка оценки красится уровнем тревоги, а не всегда жёлтым', () => {
    const alarming = snapshot.limits.find((limit) => !limit.exact && limit.usedPercent !== null)!
    const html = headerMarkup({
      ...snapshot,
      limits: [{ ...alarming, usedPercent: 92 }],
    })
    expect(html).toContain('repeating-linear-gradient')
    expect(html).toContain('var(--alarm)')
    expect(html).not.toContain('var(--warn)')
  })

  /** Ловит шапку, которая падает или рисует выдуманную полосу при пустых limits. */
  it('пустые limits не рисуют ни одной полосы', () => {
    const html = headerMarkup(empty)
    expect(empty.limits).toEqual([])
    expect(html).not.toContain('width:56px')
    expect(html).not.toContain('CL ')
    expect(html).not.toContain('CX ')
  })
})
