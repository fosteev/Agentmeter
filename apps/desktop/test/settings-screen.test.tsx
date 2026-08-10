import { renderToStaticMarkup } from 'react-dom/server'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@agentmeter/core'
import type { ConfigReport, DeepPartial } from '@agentmeter/ipc'
import { SettingsAlerts } from '../src/renderer/components/SettingsAlerts.tsx'
import { SettingsAppearance } from '../src/renderer/components/SettingsAppearance.tsx'
import { SettingsPrivacy } from '../src/renderer/components/SettingsPrivacy.tsx'
import { SettingsTab } from '../src/renderer/components/SettingsTab.tsx'
import { setLocale } from '../src/renderer/format.ts'

/**
 * Экран настроек (3.6) — раздел 6 макета.
 *
 * Проверяется не «нарисовалось», а то, что каждая ручка отправляет **ту**
 * правку: тумблер, который переключается на экране и шлёт не то поле, выглядит
 * работающим ровно до следующего запуска.
 */
setLocale('ru')

function report(over: DeepPartial<Config> = {}): ConfigReport {
  const config = structuredClone(DEFAULT_CONFIG)
  Object.assign(config.ui, over.ui ?? {})
  Object.assign(config.privacy, over.privacy ?? {})
  Object.assign(config.alerts, over.alerts ?? {})
  return {
    config,
    problems: [],
    sources: [
      { provider: 'claude', path: '/home/u/.claude', readable: true, files: 412, bytes: 597_688_320 },
      { provider: 'codex', path: '/home/u/.codex', readable: false, files: 88, bytes: 42_991_616 },
    ],
  }
}

interface Props {
  children?: ReactNode
  onClick?: () => void
  onChange?: (event: { currentTarget: { value: string; checked: boolean } }) => void
  'data-setting'?: string
  'data-theme-choice'?: string
  'data-locale-choice'?: string
  'data-settings-section'?: string
}

/**
 * Ручки ищутся в дереве **раздела**, а не всего экрана: `SettingsTab` держит
 * состояние хуком, и вызвать его функцией напрямую нельзя, а разделы — чистые
 * функции от конфига. Тот же приём, что у `TodayFilters` в `today.test.tsx`.
 */
function elements(node: ReactNode): Array<ReactElement<Props>> {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Props>
  // Вложенные компоненты (`Switch`, `Threshold`) в дереве лежат нераскрытыми:
  // React раскрыл бы их при отрисовке, а обход по `children` до их разметки не
  // добирается. Они чистые функции, поэтому раскрываются вызовом.
  const inner =
    typeof element.type === 'function'
      ? elements((element.type as (props: Props) => ReactNode)(element.props))
      : []
  return [
    element,
    ...Children.toArray(element.props.children).flatMap((child) => elements(child)),
    ...inner,
  ]
}

function find(tree: ReactNode, attribute: keyof Props, value: string): ReactElement<Props> {
  const found = elements(tree).find((element) => element.props[attribute] === value)
  expect(found, `${String(attribute)}=${value} не найден`).toBeDefined()
  return found!
}

describe('экран настроек', () => {
  /** Ловит потерянный раздел: их пять, и каждый из макета. */
  it('рисует пять разделов и открывает первый', () => {
    const html = renderToStaticMarkup(<SettingsTab report={report()} onChange={() => undefined} />)

    expect(html.split('data-settings-section=').length - 1).toBe(5)
    expect(html).toContain('data-settings-pane="sources"')
    expect(html).toContain('Источники данных')
    expect(html).toContain('Приватность')
  })

  /**
   * Ловит строку источника, показывающую бодрое «✓ 412 файлов» над каталогом,
   * которого нет: в отчёте это разные поля, и различать их обязан экран.
   */
  it('различает прочитанный источник и пропавший каталог', () => {
    const html = renderToStaticMarkup(<SettingsTab report={report()} onChange={() => undefined} />)

    expect(html).toContain('/home/u/.claude')
    expect(html).toContain('412 файлов')
    expect(html).toContain('570.0 МБ')
    expect(html).toContain('каталог не найден')
    // У пропавшего каталога цифр нет вовсе — иначе они читаются как сегодняшние.
    expect(html).not.toContain('88 файлов')
  })

  /** Ловит замечания загрузчика, которые некуда показать: они и есть ответ. */
  it('показывает замечания к файлу настроек', () => {
    const withProblems = { ...report(), problems: ['ui.theme: допустимо system | light | dark'] }
    const html = renderToStaticMarkup(
      <SettingsTab report={withProblems} onChange={() => undefined} />,
    )

    expect(html).toContain('data-config-problems')
    expect(html).toContain('ui.theme')
  })

  /** Ловит кнопку темы, отправляющую не ту правку или не отправляющую ничего. */
  it('выбор темы отправляет ui.theme', () => {
    const onChange = vi.fn()
    const tree = SettingsAppearance({ config: report().config, onChange })

    find(tree, 'data-theme-choice', 'dark').props.onClick!()

    expect(onChange).toHaveBeenCalledWith({ ui: { theme: 'dark' } })
  })

  /** Ловит выбор языка, подменяющий настройку `system` конкретным языком. */
  it('в языке три пункта, и «системный» — отдельное значение', () => {
    const onChange = vi.fn()
    const tree = SettingsAppearance({ config: report().config, onChange })

    find(tree, 'data-locale-choice', 'system').props.onClick!()
    find(tree, 'data-locale-choice', 'en').props.onClick!()

    expect(onChange).toHaveBeenNthCalledWith(1, { ui: { locale: 'system' } })
    expect(onChange).toHaveBeenNthCalledWith(2, { ui: { locale: 'en' } })
    // Имя языка написано на нём самом: его читает тот, кто текущего не понимает.
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('Русский')
    expect(html).toContain('English')
  })

  /** Ловит тумблер приватности, отправляющий чужое поле. */
  it('тумблеры приватности отправляют свои поля', () => {
    const onChange = vi.fn()
    const tree = SettingsPrivacy({ config: report().config, onChange })

    find(tree, 'data-setting', 'hidePrompts').props.onChange!({
      currentTarget: { value: '', checked: true },
    })
    find(tree, 'data-setting', 'hidePaths').props.onChange!({
      currentTarget: { value: '', checked: true },
    })

    expect(onChange).toHaveBeenNthCalledWith(1, { privacy: { hidePrompts: true } })
    expect(onChange).toHaveBeenNthCalledWith(2, { privacy: { hidePaths: true } })
  })

  /**
   * Ловит ползунки, которые пропускают друг друга: пороги, при которых тревога
   * ниже предупреждения, загрузчик отвергает целиком, и допускать их на экране
   * значит показывать положение, которое не сохранится.
   */
  it('ползунки порогов не пропускают друг друга', () => {
    const tree = SettingsAlerts({
      config: report({ alerts: { warnAtPercent: 70, dangerAtPercent: 90 } }).config,
      onChange: () => undefined,
    })

    const warn = find(tree, 'data-setting', 'warn')
    const danger = find(tree, 'data-setting', 'danger')

    expect((warn.props as { max?: number }).max).toBe(90)
    expect((danger.props as { min?: number }).min).toBe(70)
  })
})
