import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TraySnapshot } from '@agentmeter/ipc'
import { Popup } from '../src/renderer/components/Popup.tsx'
import { PopupProblem } from '../src/renderer/components/PopupProblem.tsx'
import { setLocale } from '../src/renderer/format.ts'

// Все входы — пришитые к контракту фикстуры. Составлять удобные снимки внутри
// теста нельзя: такой тест проверял бы договор, которого у main на самом деле
// нет, и спокойно зеленел бы рядом с несовместимым JSON.

const root = fileURLToPath(new URL('../../../', import.meta.url))

function fixture(name: string): TraySnapshot {
  return JSON.parse(readFileSync(`${root}fixtures/popup/${name}.json`, 'utf8')) as TraySnapshot
}

const snapshots = {
  empty: fixture('empty'),
  error: fixture('error'),
  indexing: fixture('indexing'),
  nobody: fixture('nobody'),
  normal: fixture('snapshot'),
}

setLocale('ru')

function markup(snapshot: TraySnapshot): string {
  return renderToStaticMarkup(<Popup snapshot={snapshot} now={snapshot.at + 2000} />)
}

describe('выбор состояния попапа', () => {
  /** Ловит частичные цифры, показанные как полные рядом с живым агентом. */
  it('ошибка выигрывает у обычного попапа и объясняет неполноту', () => {
    const html = markup(snapshots.error)
    const problem = snapshots.error.problems[0]!
    expect(snapshots.error.agents.length).toBeGreaterThan(0)
    expect(html).toContain(`Не читаются логи Codex`)
    expect(html).toContain(`${problem.code} ${problem.path}`)
    expect(html).toContain(problem.consequence)
    expect(html).toContain('aria-label="Ошибка чтения"')
    expect(html).not.toContain(snapshots.error.agents[0]!.project)
  })

  /** Ловит пустую раму во время первого прохода по истории. */
  it('индексирование выигрывает у пустого состояния', () => {
    const html = markup(snapshots.indexing)
    expect(snapshots.indexing.agents).toEqual([])
    expect(html).toContain('Первичное индексирование')
    expect(html).not.toContain('Агенты ещё не запускались')
  })

  /** Ловит полосу по числу файлов: она врёт на транскриптах разного размера. */
  it('прогресс индексирования строится по байтам и форматируется из снимка', () => {
    const html = markup(snapshots.indexing)
    expect(html).toContain('width:63%')
    expect(html).toContain('359 / 570 МБ')
    expect(html).toContain('≈ 40 с')
  })

  /** Ловит пустой экран без ответа на вопрос «что теперь делать». */
  it('первый запуск показывает дословную инструкцию из макета', () => {
    const html = markup(snapshots.empty)
    expect(html).toContain('Агенты ещё не запускались')
    expect(html).toContain(
      'Запустите Claude Code или Codex — Agentmeter подхватит сессию сам, за пару секунд.',
    )
    expect(html).not.toContain('Сейчас работают')
  })

  /** Ловит крупный ноль, который выдаёт отсутствие истории за измерение. */
  it('до первого запуска нулевая сумма за сутки скрыта', () => {
    const html = markup(snapshots.empty)
    expect(snapshots.empty.today.total.value).toBe(0)
    expect(html).not.toMatch(/font-size:15px;font-weight:600[^>]*>0<\/span>/)
  })

  /** Ловит потерю `lastAgent`, после которой пауза выглядит первым запуском. */
  it('пауза показывает последнего агента, а не экран первого запуска', () => {
    const html = markup(snapshots.nobody)
    expect(html).toContain('Никого. Последний —')
    expect(html).toContain('Codex · troy')
    expect(html).toContain('18 мин назад')
    expect(html).not.toContain('Агенты ещё не запускались')
  })

  /** Ловит подпись, которая не объясняет, что без агентов расход окна замер. */
  it('известные лимиты в паузе говорят, что она их не расходует', () => {
    const html = markup(snapshots.nobody)
    const known = snapshots.nobody.limits.filter((window) => window.usedPercent !== null)
    expect(known.length).toBeGreaterThan(0)
    expect(html.split('пауза его не расходует').length - 1).toBe(known.length)
  })

  /**
   * Ловит вторую недоступную сторону, потерянную по дороге.
   *
   * Вход производный: две сломанных стороны разом в фикстурах не лежат, потому
   * что макет рисует один случай, а не потому, что второй невозможен. Показать
   * из двух проблем одну значит сказать «цифры Codex неполные», умолчав, что и
   * Claude не прочитан, — то есть соврать ровно тем способом, ради которого
   * этот экран и существует.
   */
  it('обе недоступные стороны названы, а не только первая', () => {
    const both: TraySnapshot = {
      ...snapshots.error,
      problems: [
        ...snapshots.error.problems,
        {
          provider: 'claude',
          path: '~/.claude/projects',
          code: 'ENOENT',
          consequence: 'цифры Claude за сегодня — неполные.',
        },
      ],
    }
    const html = markup(both)
    for (const problem of both.problems) {
      expect(html).toContain(`${problem.code} ${problem.path}`)
      expect(html).toContain(problem.consequence)
    }
    expect(html).toContain('Не читаются логи Codex и Claude')
  })

  /**
   * Ловит форматтер токенов, применённый к мегабайтам и секундам: суффикс
   * тысяч превратил бы гигабайтный каталог логов в «1.2k МБ», а час
   * ожидания — в «3.6k с». На сегодняшних 570 МБ и сорока секундах этого не
   * видно вовсе.
   */
  it('крупный объём и долгое ожидание не получают суффикс тысяч', () => {
    const big: TraySnapshot = {
      ...snapshots.indexing,
      indexing: {
        ...snapshots.indexing.indexing!,
        bytesDone: 1_258_291_200,
        bytesTotal: 2_516_582_400,
        etaMs: 3_600_000,
      },
    }
    const html = markup(big)
    expect(html).not.toMatch(/\d[.,]?\d*k\s*(?:МБ|с)/)
    expect(html).toContain('МБ')
  })

  /** Ловит кнопки, которые выглядят рабочими, но уходят не в свои каналы. */
  it('кнопки ошибки открывают настройки и запускают переиндексацию', () => {
    const open = vi.fn(() => Promise.resolve())
    const rebuild = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      agentmeter: {
        'window:open': open,
        'index:rebuild': rebuild,
      },
    })

    const tree = PopupProblem({ snapshot: snapshots.error })
    const buttons = findButtons(tree)
    expect(buttons.map((button) => button.props.children)).toEqual(['Указать путь', 'Повторить'])
    buttons[0]!.props.onClick?.()
    buttons[1]!.props.onClick?.()
    expect(open).toHaveBeenCalledWith({ tab: 'settings' })
    expect(rebuild).toHaveBeenCalledOnce()

    vi.unstubAllGlobals()
  })

  /**
   * Ловит отказ пересборки, проглоченный молча (7.2).
   *
   * Прежние числа под прежним «обновлено 2 с назад» после нажатия на кнопку
   * врут дважды — и цифрами, и временем, — поэтому отказ забирает экран
   * целиком, как нечитаемые логи.
   */
  it('отказ пересборки уводит попап в состояние ошибки', () => {
    const html = renderToStaticMarkup(
      <Popup
        snapshot={snapshots.normal}
        now={snapshots.normal.at + 2000}
        refresh={{ busy: false, failure: 'SQLITE_BUSY: database is locked' }}
      />,
    )
    expect(html).toContain('Не удалось обновить')
    expect(html).toContain('SQLITE_BUSY: database is locked')
    expect(html).toContain('Числа на экране — от прошлого снимка.')
    // Ни прежнего списка, ни прежней свежести.
    expect(html).not.toContain('обновлено')
    expect(html).not.toContain(snapshots.normal.agents[0]!.project)
  })

  /**
   * Ловит вторую беду, потерянную за первой: нечитаемый источник никуда не
   * делся оттого, что вдобавок отказала пересборка, и умолчать о нём значит
   * назвать неполные цифры полными.
   */
  it('отказ пересборки не заслоняет нечитаемые логи', () => {
    const html = renderToStaticMarkup(
      <Popup
        snapshot={snapshots.error}
        now={snapshots.error.at + 2000}
        refresh={{ busy: false, failure: 'EPERM' }}
      />,
    )
    const problem = snapshots.error.problems[0]!
    expect(html).toContain('EPERM')
    expect(html).toContain(`${problem.code} ${problem.path}`)
    expect(html).toContain(problem.consequence)
  })

  /**
   * Ловит «Повторить», которое после отказа пересборки зовёт переиндексацию:
   * индекс тут ни при чём, повторять надо то, что не вышло.
   */
  it('после отказа «Повторить» повторяет пересборку, а не переиндексацию', () => {
    const rebuild = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { agentmeter: { 'index:rebuild': rebuild } })
    const retry = vi.fn()

    const tree = PopupProblem({
      snapshot: snapshots.normal,
      failure: 'SQLITE_BUSY',
      onRetry: retry,
    })
    const buttons = findButtons(tree)
    // Кнопки «Указать путь» здесь нет: путь ни при чём, менять его незачем.
    expect(buttons.map((button) => button.props.children)).toEqual(['Повторить'])
    buttons[0]!.props.onClick?.()
    expect(retry).toHaveBeenCalledOnce()
    expect(rebuild).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  /**
   * Ловит окна лимита, оставшиеся без провайдера (7.1). Бейдж из строки лимита
   * ушёл вместе с табами, но табов в паузе нет — окна обоих провайдеров лежат
   * тут одним списком, и назвать их больше нечем.
   */
  it('в паузе имя окна называет провайдера', () => {
    const html = markup(snapshots.nobody)
    for (const window of snapshots.nobody.limits) {
      expect(html).toContain(window.provider === 'claude' ? 'Claude, ' : 'Codex, ')
    }
    expect(html).not.toContain('>CL<')
  })

  /**
   * Ловит кнопку обновления, доставшуюся одному состоянию из четырёх.
   * «Поток встал» выглядит убедительнее всего там, где на экране написано, что
   * никого нет: именно в этих состояниях руками пересобрать снимок и хочется.
   */
  it('кнопка обновления есть во всех состояниях с шапкой', () => {
    for (const state of ['empty', 'indexing', 'nobody', 'normal'] as const) {
      const html = renderToStaticMarkup(
        <Popup
          snapshot={snapshots[state]}
          now={snapshots[state].at + 2000}
          onRefresh={() => undefined}
        />,
      )
      expect(html, state).toContain('data-popup-action="refresh"')
    }
  })

  /** Ловит новый селектор, который проглотил уже работающий обычный попап. */
  it('живые агенты без ошибки остаются обычным попапом', () => {
    const html = markup(snapshots.normal)
    expect(html).toContain('Сейчас работают')
    for (const agent of snapshots.normal.agents) expect(html).toContain(agent.project)
    expect(html).not.toContain('Первичное индексирование')
    expect(html).not.toContain('Агенты ещё не запускались')
  })
})

describe('рама попапа одна на все состояния', () => {
  const STATES = ['Popup', 'PopupEmpty', 'PopupIdle', 'PopupIndexing', 'PopupProblem']

  /**
   * Ловит вернувшуюся зашитую высоту. Окно подгоняется под содержимое
   * (`useFitWindow` в `main.tsx`), и `height: 600` в любом из пяти состояний
   * означает не «попап на 600 точек», а «под коротким содержимым пустое поле,
   * а под длинным — прокрутка у самого окна, поверх интерфейса».
   *
   * Заодно ловит шестое состояние, свёрстанное своей рамой: пять копий
   * двенадцати строк стиля тут уже лежали, и правка в одной означала, что
   * четыре попапа теперь другого размера.
   */
  it('ни одно состояние не рисует свою раму и не зашивает высоту', () => {
    const drifted: string[] = []
    for (const name of STATES) {
      const src = readFileSync(
        fileURLToPath(new URL(`../src/renderer/components/${name}.tsx`, import.meta.url)),
        'utf8',
      )
      if (!src.includes('<PopupShell>')) drifted.push(`${name}: рама своя, а не PopupShell`)
      // Три цифры и больше: полоски и кружки внутри состояний законно меряются
      // числом (`height: 22`), а на всю раму столько не бывает.
      const pinned = src.replace(/\/\/.*$/gm, '').match(/\bheight:\s*\d{3,}/)
      if (pinned !== null) drifted.push(`${name}: ${pinned[0]}`)
    }
    expect(drifted).toEqual([])
  })
})

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
