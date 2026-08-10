import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TraySnapshot } from '../src/index.ts'
import { IPC_CALLS, IPC_EVENTS } from '../src/index.ts'

/**
 * Фикстура попапа обязана быть ровно тем, что описывает контракт.
 *
 * Тест не про вёрстку — про то, что вход тестов 2.5 не разошёлся с типом. Файл
 * разбирается приведением к `TraySnapshot`, а приведение молчит и о лишних
 * полях, и о недостающих: `as` — не проверка. Здесь проверка.
 */
function fixture(name: string): TraySnapshot {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/popup/${name}.json`, import.meta.url)),
      'utf8',
    ),
  ) as TraySnapshot
}

const snapshot = fixture('snapshot')

/** Четыре экрана раздела 7 макета — вход 2.8, по файлу на состояние. */
const STATES = ['empty', 'indexing', 'error', 'nobody'] as const
const states = Object.fromEntries(STATES.map((name) => [name, fixture(name)])) as Record<
  (typeof STATES)[number],
  TraySnapshot
>

describe('fixtures/popup/snapshot.json — контракт 0.4', () => {
  /**
   * Ловит фикстуру, отставшую от контракта: попап собирается по типу, а
   * данные для тестов — по этому файлу, и разойтись они могут молча.
   */
  it('поля снимка ровно те, что в TraySnapshot', () => {
    expect(Object.keys(snapshot).sort()).toEqual(
      ['agents', 'at', 'limits', 'nearestLimitPercent', 'problems', 'today'].sort(),
    )
    expect(Object.keys(snapshot.today).sort()).toEqual(
      [
        'cacheRead',
        'cacheWrite',
        'input',
        'output',
        'projects',
        'requests',
        'sessions',
        'total',
      ].sort(),
    )
    for (const agent of snapshot.agents) {
      expect(typeof agent.rate).toBe('number')
      expect(typeof agent.approximate).toBe('boolean')
    }
  })

  /**
   * Ловит вход, на котором проверки 2.5 зелены на любом коде. Незнание,
   * оценка и точное число — три разных случая, и если в фикстуре остался
   * только последний, проверять нечего.
   */
  it('несёт все три случая точности и все состояния, ради которых сделана', () => {
    expect(snapshot.limits.some((window) => window.usedPercent === null)).toBe(true)
    expect(snapshot.limits.some((window) => window.exact)).toBe(true)
    expect(snapshot.limits.some((window) => !window.exact && window.usedPercent !== null)).toBe(
      true,
    )
    expect(snapshot.agents.some((agent) => agent.approximate)).toBe(true)
    // Все четыре состояния, включая `idle` из 2.2: макетом оно не нарисовано,
    // и без строки в фикстуре проверять его нечем.
    expect(new Set(snapshot.agents.map((agent) => agent.state))).toEqual(
      new Set(['working', 'waiting', 'idle', 'done']),
    )
    const done = snapshot.agents.find((agent) => agent.state === 'done')!
    expect(done.endedAt).toBeLessThan(snapshot.at)
  })

  /**
   * Ловит фикстуру, на которой попап нельзя собрать без счёта в окне.
   *
   * `total` в подвале обязан быть суммой четырёх видов, а не «примерно тем же
   * числом»: разойдись он с ними — и тест попапа зафиксирует расхождение как
   * норму. Точность суммы — худшая из четырёх, иначе восстановленное чтение
   * кэша уедет в подвал точным числом.
   */
  it('total в подвале сходится с четырьмя видами и несёт худшую из их точностей', () => {
    const { input, output, cacheWrite, cacheRead, total } = snapshot.today
    expect(total.value).toBe(input.value + output.value + cacheWrite.value + cacheRead.value)
    const ranks = { exact: 0, reconstructed: 1, estimate: 2 } as const
    const worst = [input, output, cacheWrite, cacheRead].reduce((a, b) =>
      ranks[a.confidence] >= ranks[b.confidence] ? a : b,
    )
    expect(total.confidence).toBe(worst.confidence)
    expect(total.caveat).toBe(worst.caveat)
  })

  /**
   * Ловит вход, на котором проверки 2.6 зелены на любом коде.
   *
   * У заполнения контекста три случая, и они разные по природе: размер окна
   * написал провайдер (Codex), размер окна выведен из наблюдений (Claude) и
   * выводить не из чего вовсе — тогда поля нет. Останься в фикстуре один из
   * трёх, и «оценка отмечена, точное — нет» проверяла бы пустоту.
   */
  it('несёт все три случая заполнения контекста', () => {
    const withContext = snapshot.agents.filter((agent) => agent.context !== undefined)
    expect(withContext.some((agent) => agent.context!.confidence === 'exact')).toBe(true)
    expect(withContext.some((agent) => agent.context!.confidence === 'estimate')).toBe(true)
    expect(snapshot.agents.some((agent) => agent.context === undefined)).toBe(true)

    for (const agent of withContext) {
      const { used, window, fill, confidence, caveat } = agent.context!
      // Доля обязана быть той самой долей: разойдись она с числами, и попап
      // покажет полосу одной длины, а подпись — другого процента.
      expect(fill).toBeCloseTo(used / window, 6)
      expect(fill).toBeGreaterThan(0)
      expect(fill).toBeLessThanOrEqual(1)
      // Оценка без объяснения заставляет гадать, что именно неточно, —
      // неточен здесь только знаменатель.
      if (confidence === 'estimate') expect(caveat).toBeTruthy()
      else expect(caveat).toBeUndefined()
    }
  })

  /**
   * Ловит вход, на котором проверка «незнание не показано нулём» проверяет
   * пустоту: без причины у окна без процента попапу нечего вывести текстом,
   * и любая реализация пройдёт.
   */
  it('у окна без процента есть причина, у окон с процентом её нет', () => {
    for (const window of snapshot.limits) {
      if (window.usedPercent === null) {
        expect(window.unavailableReason).toBeTruthy()
        expect(window.forecast).toBeNull()
      } else {
        expect(window.unavailableReason).toBeNull()
      }
    }
  })

  /**
   * Ловит фикстуру состояния, отставшую от контракта. Разбор приведением молчит
   * о любых полях, поэтому набор ключей проверяется списком: экран, собранный
   * по выдуманному полю, покажет пустоту на настоящих данных.
   */
  it('фикстуры состояний — те же поля TraySnapshot и ничего сверх', () => {
    const allowed = new Set([
      'at',
      'agents',
      'limits',
      'today',
      'nearestLimitPercent',
      'indexing',
      'problems',
      'lastAgent',
    ])
    for (const [name, state] of Object.entries(states)) {
      const extra = Object.keys(state).filter((key) => !allowed.has(key))
      expect(extra, `${name}: лишние поля`).toEqual([])
      expect(typeof state.at, `${name}: нет момента снимка`).toBe('number')
      expect(Array.isArray(state.problems), `${name}: problems обязателен`).toBe(true)
    }
  })

  /**
   * Ловит вход, на котором два разных экрана неразличимы.
   *
   * «Агенты ещё не запускались» и «сейчас никто не работает» — это разные
   * слова и разная раскладка, а данные у них отличаются ровно одним полем.
   * Совпади фикстуры — и любая реализация покажет один экран вместо двух.
   */
  it('пусто и никого-нет различаются только историей', () => {
    expect(states.empty.agents).toEqual([])
    expect(states.nobody.agents).toEqual([])
    expect(states.empty.lastAgent).toBeUndefined()
    expect(states.nobody.lastAgent).toBeTruthy()
    expect(states.nobody.lastAgent!.endedAt).toBeLessThan(states.nobody.at)
    // У «никого нет» лимиты и сутки на месте: пауза окно не расходует, и
    // прятать расход за отсутствие живых агентов нечестно.
    expect(states.nobody.limits.length).toBeGreaterThan(0)
    expect(states.empty.limits).toEqual([])
    expect(states.empty.today.total.value).toBe(0)
  })

  /**
   * Ловит вход, на котором экран индексирования нечем нарисовать по макету:
   * там полоса и «359 / 570 МБ» с оценкой оставшегося времени, а не число
   * файлов. Плюс требование текста макета — сегодняшний день уже доступен.
   */
  it('индексирование несёт байты, оценку времени и уже доступные сутки', () => {
    const indexing = states.indexing.indexing
    expect(indexing).toBeTruthy()
    expect(indexing!.phase).toBe('parsing')
    expect(indexing!.bytesDone).toBeGreaterThan(0)
    expect(indexing!.bytesDone).toBeLessThan(indexing!.bytesTotal)
    expect(indexing!.etaMs).toBeGreaterThan(0)
    expect(states.indexing.today.total.value).toBeGreaterThan(0)
  })

  /**
   * Ловит вход, на котором экран ошибки проверяет пустоту. Ошибка здесь
   * частичная: Codex недоступен, а Claude прочитан — и если в фикстуре нет
   * второй половины, «данные Claude показываются как обычно» проверить нечем.
   */
  it('ошибка названа кодом, путём, последствием — и половина данных цела', () => {
    const [problem, ...rest] = states.error.problems
    expect(problem).toBeTruthy()
    expect(rest).toEqual([])
    expect(problem!.code).toBeTruthy()
    expect(problem!.path).toBeTruthy()
    expect(problem!.consequence).toBeTruthy()
    expect(states.error.agents.every((agent) => agent.provider !== problem!.provider)).toBe(true)
    expect(states.error.agents.length).toBeGreaterThan(0)
    expect(states.error.limits.length).toBeGreaterThan(0)
  })

  /**
   * Ловит канал, добавленный строкой мимо контракта: списки — единственный
   * источник имён и для main, и для preload.
   */
  it('списки каналов не пусты и не пересекаются', () => {
    expect(IPC_CALLS.length).toBeGreaterThan(0)
    expect(IPC_EVENTS.length).toBeGreaterThan(0)
    expect(IPC_CALLS.filter((name) => (IPC_EVENTS as readonly string[]).includes(name))).toEqual([])
  })
})
