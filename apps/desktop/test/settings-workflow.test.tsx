import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@agentmeter/core'
import type { ConfigReport, DeepPartial } from '@agentmeter/ipc'
import {
  SettingsWorkflow,
  fieldToShare,
  multipleToField,
  newRule,
  parseField,
  shareToField,
  workflowProblems,
} from '../src/renderer/components/SettingsWorkflow.tsx'
import { SettingsTab } from '../src/renderer/components/SettingsTab.tsx'
import { setLocale } from '../src/renderer/format.ts'

/**
 * Раздел «Workflow» в настройках (9.5): каждая ручка шлёт **ту** правку.
 *
 * Конфиг хранит доли, а поле показывает проценты; список правил заменяется
 * целиком; сервер вправе отвергнуть присланное, и раздел обязан это показать.
 * Всё это ломается молча: поле «20» с записью `20` вместо `0.2` проходит любую
 * проверку, кроме той, что читает отправленное.
 */
setLocale('ru')
afterEach(() => setLocale('ru'))

function config(over: DeepPartial<Config['workflow']> = {}): Config {
  const value = structuredClone(DEFAULT_CONFIG)
  Object.assign(value.workflow, { enabled: true }, over)
  return value
}

type Handler = (event?: unknown) => void

interface Props {
  children?: ReactNode
  'data-setting'?: string
  'data-workflow-rule-action'?: string
  'data-workflow-add'?: string
  onBlur?: Handler
  onKeyDown?: Handler
  onChange?: Handler
  onClick?: Handler
  onSubmit?: Handler
  disabled?: boolean
  [key: string]: unknown
}

/** Дерево раздела с раскрытыми вложенными компонентами (они чистые функции). */
function elements(node: ReactNode): Array<ReactElement<Props>> {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Props>
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

function find(tree: ReactNode, attribute: string, value: string): ReactElement<Props> {
  const found = elements(tree).find((element) => element.props[attribute] === value)
  expect(found, `${attribute}=${value} не найден`).toBeDefined()
  return found!
}

function mount(over: DeepPartial<Config['workflow']> = {}, problems: string[] = []) {
  const onChange = vi.fn()
  const tree = SettingsWorkflow({ config: config(over), problems, onChange })
  return { tree, onChange }
}

/** Поле, у которого фокус ушёл со значением `text`. Возвращает «DOM-значение» после. */
function blur(tree: ReactNode, name: string, text: string): { value: string } {
  const target = { value: text, blur: vi.fn() }
  find(tree, 'data-setting', name).props.onBlur!({ currentTarget: target })
  return target
}

describe('раздел «Workflow»: место и выключатель', () => {
  const report = (): ConfigReport =>
    ({
      config: config(),
      problems: [],
      sources: [],
      startup: { enabled: false, available: true },
      update: { phase: 'idle', current: '0.1.0' },
      usageApi: { enabled: false, credentials: 'missing', needsLogin: false },
      codexApi: { enabled: false, credentials: 'missing', needsLogin: false },
    }) as ConfigReport

  /** Ловит раздел не на своём месте: шестым после «Приватности», перед «Приложением». */
  it('в списке настроек — после «Приватности»', () => {
    const noop = () => undefined
    const html = renderToStaticMarkup(
      <SettingsTab
        report={report()}
        onChange={noop}
        onStartup={noop}
        onOauth={noop}
        onRefreshOauth={noop}
        onCheckUpdate={noop}
        onInstallUpdate={noop}
        section="workflow"
      />,
    )

    expect(html.split('data-settings-section=').length - 1).toBe(7)
    expect(html.indexOf('Приватность')).toBeLessThan(html.indexOf('>Workflow<'))
    expect(html.indexOf('>Workflow<')).toBeLessThan(html.indexOf('Приложение'))
    expect(html).toContain('data-settings-pane="workflow"')
    expect(html).toContain('data-workflow-settings')
  })

  /**
   * Ловит «Workflow выключен», показанное при включённом экране, и пропавшее при
   * выключенном: текст стоит над выключателем, потому что вкладки у выключенного
   * экрана нет и сказать это больше негде.
   */
  it('«Workflow выключен» — над выключателем и только пока выключено', () => {
    const off = renderToStaticMarkup(SettingsWorkflow({ config: config({ enabled: false }), problems: [], onChange: () => undefined }))
    const on = renderToStaticMarkup(SettingsWorkflow({ config: config(), problems: [], onChange: () => undefined }))

    expect(off).toContain('data-workflow-off')
    expect(off).toContain('Workflow выключен')
    expect(off.indexOf('Workflow выключен')).toBeLessThan(off.indexOf('data-setting="workflowEnabled"'))
    expect(on).not.toContain('data-workflow-off')
  })

  it('выключатель шлёт workflow.enabled', () => {
    const { tree, onChange } = mount({ enabled: false })

    find(tree, 'data-setting', 'workflowEnabled').props.onChange!({
      currentTarget: { checked: true },
    })

    expect(onChange).toHaveBeenCalledWith({ workflow: { enabled: true } })
  })
})

describe('раздел «Workflow»: правила ролей', () => {
  const rules = DEFAULT_CONFIG.workflow.roles

  /** Ловит правки, отправляющие один элемент: список заменяется целиком, порядок значим. */
  it('смена роли шлёт весь список с тем же порядком', () => {
    const { tree, onChange } = mount()

    find(tree, 'data-setting', 'workflowRole1').props.onChange!({
      currentTarget: { value: 'planner' },
    })

    expect(onChange).toHaveBeenCalledWith({
      workflow: {
        roles: [rules[0], { match: 'review-*', role: 'planner' }, rules[2], rules[3]],
      },
    })
  })

  /**
   * Ловит стрелки, переставляющие не то или шлющие тот же порядок: побеждает первое
   * совпавшее правило, и перестановка — это смена результата.
   */
  it('стрелки двигают правило, крайние отключены', () => {
    const { tree, onChange } = mount()
    const action = (index: number, name: string) =>
      elements(tree)
        .filter((el) => el.props['data-workflow-rule-action'] === name)
        .at(index)!

    action(2, 'up').props.onClick!()
    action(0, 'down').props.onClick!()

    expect(onChange).toHaveBeenNthCalledWith(1, {
      workflow: { roles: [rules[0], rules[2], rules[1], rules[3]] },
    })
    expect(onChange).toHaveBeenNthCalledWith(2, {
      workflow: { roles: [rules[1], rules[0], rules[2], rules[3]] },
    })
    expect(action(0, 'up').props.disabled).toBe(true)
    expect(action(3, 'down').props.disabled).toBe(true)
    expect(action(1, 'up').props.disabled).toBe(false)
  })

  it('«×» убирает ровно это правило; пустой список законен', () => {
    const { tree, onChange } = mount({ roles: [{ match: 'x-*', role: 'executor' }] })

    elements(tree)
      .find((el) => el.props['data-workflow-rule-action'] === 'remove')!
      .props.onClick!()

    expect(onChange).toHaveBeenCalledWith({ workflow: { roles: [] } })
  })

  /** Ловит шаблон, записанный без изменений или пустым: пустое не правило. */
  it('шаблон правится по уходу фокуса; тот же и пустой не отправляются', () => {
    const { tree, onChange } = mount()

    blur(tree, 'workflowRule0', 'exec-*')
    blur(tree, 'workflowRule0', '   ')
    expect(onChange).not.toHaveBeenCalled()

    blur(tree, 'workflowRule0', ' agent-* ')
    expect(onChange).toHaveBeenCalledWith({
      workflow: { roles: [{ match: 'agent-*', role: 'executor' }, rules[1], rules[2], rules[3]] },
    })
  })

  /** Ловит Enter, не уводящий фокус (правка не уйдёт), и Esc, оставляющий набранное. */
  it('Enter закрепляет поле, Esc откатывает набранное', () => {
    const { tree } = mount()
    const field = find(tree, 'data-setting', 'workflowRule0')
    const enter = { key: 'Enter', currentTarget: { value: 'x', blur: vi.fn() } }
    const escape = { key: 'Escape', currentTarget: { value: 'набрано', blur: vi.fn() } }

    field.props.onKeyDown!(enter)
    field.props.onKeyDown!(escape)

    expect(enter.currentTarget.blur).toHaveBeenCalledTimes(1)
    expect(escape.currentTarget.blur).toHaveBeenCalledTimes(1)
    expect(escape.currentTarget.value).toBe('exec-*')
  })

  /**
   * Ловит «+ правило», добавляющее пустое правило или не ту роль. Форму читает
   * `FormData`; в тесте он заменён таблицей полей.
   */
  it('новое правило — в конец списка; пустой шаблон и чужая роль не принимаются', () => {
    const fields = (values: Record<string, string>) =>
      ({ get: (name: string) => values[name] ?? null }) as unknown as FormData

    expect(newRule(fields({ match: ' qa-* ', role: 'reviewer' }))).toEqual({
      match: 'qa-*',
      role: 'reviewer',
    })
    expect(newRule(fields({ match: '', role: 'reviewer' }))).toBeNull()
    expect(newRule(fields({ match: 'qa-*', role: 'unknown' }))).toBeNull()
    expect(newRule(fields({ match: 'qa-*', role: 'main' }))).toBeNull()

    vi.stubGlobal(
      'FormData',
      class {
        get(name: string): string | null {
          return { match: 'qa-*', role: 'explore' }[name] ?? null
        }
      },
    )
    const { tree, onChange } = mount()
    const reset = vi.fn()
    elements(tree)
      .find((el) => el.props['data-workflow-add'] !== undefined)!
      .props.onSubmit!({
      preventDefault: vi.fn(),
      currentTarget: { reset },
    })
    vi.unstubAllGlobals()

    expect(onChange).toHaveBeenCalledWith({
      workflow: { roles: [...rules, { match: 'qa-*', role: 'explore' }] },
    })
    expect(reset).toHaveBeenCalledTimes(1)
  })

  /** Ловит `unknown` в списке ролей: его назначить нельзя, он остаток. */
  it('в выборе роли четыре назначаемые, без «Роли не определена»', () => {
    const html = renderToStaticMarkup(SettingsWorkflow({ config: config(), problems: [], onChange: () => undefined }))
    const select = html.slice(html.indexOf('data-setting="workflowRole0"'))
    const options = select.slice(0, select.indexOf('</select>'))

    for (const label of ['Исполнитель', 'Ревьюер', 'Планировщик', 'Разведка']) {
      expect(options).toContain(label)
    }
    expect(options).not.toContain('Роль не определена')
  })
})

describe('раздел «Workflow»: регулярки вердикта', () => {
  /** Ловит поле, шлющее чужой ключ вердикта: порядок строк — «не принят» первой. */
  it('каждая регулярка шлёт свой ключ', () => {
    const { tree, onChange } = mount()

    blur(tree, 'workflowVerdict-rejected', 'отклонено')
    blur(tree, 'workflowVerdict-notes', 'замечания')
    blur(tree, 'workflowVerdict-accepted', 'ок')

    expect(onChange).toHaveBeenNthCalledWith(1, { workflow: { verdicts: { rejected: 'отклонено' } } })
    expect(onChange).toHaveBeenNthCalledWith(2, { workflow: { verdicts: { notes: 'замечания' } } })
    expect(onChange).toHaveBeenNthCalledWith(3, { workflow: { verdicts: { accepted: 'ок' } } })
  })

  it('показывает текущие регулярки, нетронутая не отправляется', () => {
    const { tree, onChange } = mount()
    const html = renderToStaticMarkup(tree)

    expect(html).toContain('не\\s+принят|not\\s+accepted|rejected')
    blur(tree, 'workflowVerdict-notes', DEFAULT_CONFIG.workflow.verdicts.notes)
    expect(onChange).not.toHaveBeenCalled()
    // Порядок строк тот же, в каком их проверяет ядро.
    expect(html.indexOf('workflowVerdict-rejected')).toBeLessThan(html.indexOf('workflowVerdict-notes'))
    expect(html.indexOf('workflowVerdict-notes')).toBeLessThan(html.indexOf('workflowVerdict-accepted'))
  })
})

describe('раздел «Workflow»: окно, цель, пороги', () => {
  /** Ловит окно, записанное строкой или не в тот ключ. */
  it('размеры окон — числа в своих ключах', () => {
    const { tree, onChange } = mount()

    blur(tree, 'workflowWindowCycles', '3')
    blur(tree, 'workflowWindowSessions', '40')

    expect(onChange).toHaveBeenNthCalledWith(1, { workflow: { window: { cycles: 3 } } })
    expect(onChange).toHaveBeenNthCalledWith(2, { workflow: { window: { sessions: 40 } } })
  })

  /**
   * Ловит ввод, не являющийся числом: он не уходит на сервер, а набранное
   * откатывается к показанному. Пустое окно тоже не бывает — окно без размера нет.
   */
  it('не число и пустое окно не отправляются, поле откатывается', () => {
    const { tree, onChange } = mount()

    const garbage = blur(tree, 'workflowWindowCycles', 'abc')
    const empty = blur(tree, 'workflowWindowSessions', '')

    expect(onChange).not.toHaveBeenCalled()
    expect(garbage.value).toBe('10')
    expect(empty.value).toBe('20')
  })

  /**
   * Ловит главную ловушку 9.2: поле — проценты, конфиг — доли. «20» обязано уйти как
   * `0.2`, а не `20` (сервер отверг бы его, а в файл ушло бы враньё).
   */
  it('цель и пороги: проценты в поле, доли в конфиге; кратность без пересчёта', () => {
    const { tree, onChange } = mount()

    blur(tree, 'workflowTarget', '20')
    blur(tree, 'workflowAlertRework', '35')
    blur(tree, 'workflowAlertErrors', '5')
    blur(tree, 'workflowAlertOverhead', '3')

    expect(onChange).toHaveBeenNthCalledWith(1, { workflow: { target: { rework: 0.2 } } })
    expect(onChange).toHaveBeenNthCalledWith(2, { workflow: { alerts: { rework: 0.35 } } })
    expect(onChange).toHaveBeenNthCalledWith(3, { workflow: { alerts: { errorRate: 0.05 } } })
    expect(onChange).toHaveBeenNthCalledWith(4, { workflow: { alerts: { overhead: 3 } } })
  })

  /** Ловит хвост плавающей точки в файле настроек и запятую, не принятую за точку. */
  it('33,3 % пишется как 0.333, а не 0.33299999999999996', () => {
    expect(fieldToShare(33.3)).toBe(0.333)
    expect(33.3 / 100).not.toBe(0.333)
    expect(fieldToShare(7)).toBe(0.07)
    expect(parseField('33,3')).toBe(33.3)
    expect(parseField(' 12 ')).toBe(12)
    expect(parseField('')).toBeNull()
    expect(parseField('1e')).toBeUndefined()

    const { tree, onChange } = mount()
    blur(tree, 'workflowTarget', '33,3')
    expect(onChange).toHaveBeenCalledWith({ workflow: { target: { rework: 0.333 } } })
  })

  /** Ловит пустое поле, превращённое в 0%: пусто — цели или порога нет, `null`. */
  it('пустое поле цели и порогов — null', () => {
    const { tree, onChange } = mount({ target: { rework: 0.2 }, alerts: { rework: 0.5, errorRate: null, overhead: 2 } })

    blur(tree, 'workflowTarget', '')
    blur(tree, 'workflowAlertRework', '  ')
    blur(tree, 'workflowAlertOverhead', '')

    expect(onChange).toHaveBeenNthCalledWith(1, { workflow: { target: { rework: null } } })
    expect(onChange).toHaveBeenNthCalledWith(2, { workflow: { alerts: { rework: null } } })
    expect(onChange).toHaveBeenNthCalledWith(3, { workflow: { alerts: { overhead: null } } })
  })

  /**
   * Ловит округление при записи: нетронутое поле назад не пишется. Конфиг с
   * `0.12345` показывает «12.35», и уход фокуса без правки не должен превратить его
   * в `0.1235`.
   */
  it('нетронутое поле не пишется, показ округляется, запись — нет', () => {
    const { tree, onChange } = mount({ target: { rework: 0.12345 } })

    expect(shareToField(0.12345)).toBe('12.35')
    blur(tree, 'workflowTarget', '12.35')
    expect(onChange).not.toHaveBeenCalled()
    expect(shareToField(null)).toBe('')
    expect(shareToField(0.2)).toBe('20')
    expect(multipleToField(3)).toBe('3')
    expect(multipleToField(null)).toBe('')
  })

  it('поля показывают текущие значения в процентах', () => {
    const html = renderToStaticMarkup(
      SettingsWorkflow({
        config: config({ target: { rework: 0.2 }, alerts: { rework: 0.35, errorRate: null, overhead: 3 } }),
        problems: [],
        onChange: () => undefined,
      }),
    )

    expect(html).toMatch(/data-setting="workflowTarget"[^>]*value="20"|value="20"[^>]*data-setting="workflowTarget"/)
    expect(html).toMatch(/data-setting="workflowAlertRework"[^>]*value="35"|value="35"[^>]*data-setting="workflowAlertRework"/)
    expect(html).toMatch(/data-setting="workflowAlertOverhead"[^>]*value="3"|value="3"[^>]*data-setting="workflowAlertOverhead"/)
    expect(html).toContain('циклов')
    expect(html).toContain('сессий')
  })
})

describe('раздел «Workflow»: замечания сервера', () => {
  const rejected = [
    'workflow.roles[2]: ожидалось {"match": "шаблон"}, пришло 5 — правило пропущено',
    'workflow.verdicts.rejected: допустимо регулярное выражение, пришло "(" — взят дефолт',
  ]

  /**
   * Ловит ответ, принятый за успешный: сервер выбросил правило и отверг регулярку, и
   * об этом экран обязан сказать в самом разделе, а не промолчать.
   */
  it('показывает свои замечания, чужие оставляет разделу «Источники»', () => {
    const html = renderToStaticMarkup(
      SettingsWorkflow({
        config: config(),
        problems: [...rejected, 'ui.theme: допустимо system | light | dark'],
        onChange: () => undefined,
      }),
    )

    expect(html).toContain('data-workflow-problems')
    expect(html).toContain('workflow.roles[2]')
    expect(html).toContain('workflow.verdicts.rejected')
    expect(html).not.toContain('ui.theme')
    expect(workflowProblems(['ui.theme: x', 'workflow.window.cycles: y'])).toEqual(['workflow.window.cycles: y'])
  })

  it('без замечаний блока нет', () => {
    const html = renderToStaticMarkup(
      SettingsWorkflow({ config: config(), problems: ['ui.theme: x'], onChange: () => undefined }),
    )
    expect(html).not.toContain('data-workflow-problems')
  })

  /**
   * Ловит отвергнутый ввод, оставшийся в поле под видом принятого: ответ с другими
   * замечаниями обязан перерисовать поле, то есть сменить его `key`.
   */
  it('замечания меняют ключ полей: отвергнутое значение не остаётся на экране', () => {
    const keyOf = (problems: string[]) =>
      find(
        SettingsWorkflow({ config: config(), problems, onChange: () => undefined }),
        'data-setting',
        'workflowVerdict-rejected',
      ).key

    expect(keyOf([])).not.toBe(keyOf(rejected))
    expect(keyOf(rejected)).toBe(keyOf(rejected))
  })

  /**
   * Ловит отказ, повторённый дословно (приёмка 9.5): второй раз «150» в цель даёт то
   * же замечание, ключ поля не меняется, и без отката набранное висело бы в поле при
   * 0.2 в конфиге. Поле после отправки показывает конфиг — принятое приедет новым
   * `value`. То же у шаблона роли, очищенного до пустого: он не уходит, но и не висит.
   */
  it('после отправки поле показывает конфиг, а не набранное', () => {
    const { tree, onChange } = mount({ target: { rework: 0.2 } })

    expect(blur(tree, 'workflowTarget', '150').value).toBe('20')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(blur(tree, 'workflowVerdict-rejected', '(').value).toBe(
      DEFAULT_CONFIG.workflow.verdicts.rejected,
    )
    expect(blur(tree, 'workflowRule0', '   ').value).toBe(DEFAULT_CONFIG.workflow.roles[0]!.match)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  /** Ловит правку шаблона, удаляющую правило: длиннее 200 сервер выбросит его целиком. */
  it('шаблоны не длиннее границы валидатора', () => {
    const { tree } = mount()
    expect(find(tree, 'data-setting', 'workflowRule0').props.maxLength).toBe(200)
    expect(find(tree, 'data-setting', 'workflowRuleNew').props.maxLength).toBe(200)
    expect(find(tree, 'data-setting', 'workflowVerdict-notes').props.maxLength).toBe(200)
  })
})

describe('экран Workflow на английском', () => {
  /**
   * Ловит строку, оставшуюся русской при английском интерфейсе: проверка кода
   * ловит литералы, а эта — каталог, где перевод мог не быть дописан.
   */
  it('настройки Workflow без кириллицы', () => {
    setLocale('en')
    const html = renderToStaticMarkup(
      SettingsWorkflow({
        config: config({ enabled: false }),
        problems: [],
        onChange: () => undefined,
      }),
    )

    expect(html).toContain('Workflow is off')
    expect(html).toContain('Subagent roles')
    expect(html).toContain('Rework target')
    // Значения полей — настройки пользователя (регулярки по умолчанию русские), не интерфейс.
    expect(html.replace(/value="[^"]*"/g, '')).not.toMatch(/[А-Яа-яЁё]/)
  })
})
