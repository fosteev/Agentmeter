import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC_CALLS, IPC_EVENTS } from '@agentmeter/ipc'
import { registerIpc, type IpcHandlers } from '../src/main/ipc.ts'
import { toContext } from '../src/main/snapshot.ts'
import { createClient } from '../src/preload/client.ts'

// Проводка контракта 0.4. Проверки названы по поломке, которую ловят.

const here = fileURLToPath(new URL('./', import.meta.url))
const rendererDir = `${here}../src/renderer`

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sources(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(readFileSync(path, 'utf8'))
  }
  return out
}

describe('каналы main и preload — ровно контракт', () => {
  /**
   * Ловит канал, добавленный строкой мимо контракта (в рендерере он повиснет
   * `invoke` без ответа и без ошибки), и обработчик, потерянный при
   * переименовании. Сравнение в обе стороны: лишний зарегистрированный канал
   * так же плох, как забытый.
   */
  it('main регистрирует ровно IPC_CALLS, без лишних и без пропусков', () => {
    const registered: string[] = []
    const stub = new Proxy({} as IpcHandlers, { get: () => () => undefined })
    registerIpc({ handle: (channel) => registered.push(channel) }, stub)
    expect([...registered].sort()).toEqual([...IPC_CALLS].sort())
  })

  /**
   * Ловит клиент, собранный руками: в нём легко забыть канал или добавить
   * лишний, и рендерер узнает об этом в проде.
   */
  it('клиент preload обслуживает все вызовы и все события', () => {
    const client = createClient(
      () => Promise.resolve(undefined),
      () => () => undefined,
    )
    expect(Object.keys(client).sort()).toEqual(
      [...IPC_CALLS, ...IPC_EVENTS.map((name) => `on:${name}`)].sort(),
    )
  })

  /**
   * Ловит имя канала, набранное в компоненте от руки. Тип не даст ошибиться в
   * известном имени, но эта проверка ловит и то, чего тип не видит: строку,
   * уехавшую в шаблон или в `as`.
   */
  it('в рендерере нет имён каналов мимо контракта', () => {
    const known = new Set<string>([...IPC_CALLS, ...IPC_EVENTS.map((name) => `on:${name}`)])
    const suspicious: string[] = []
    for (const src of sources(rendererDir)) {
      for (const [, name] of src.matchAll(/['"]((?:on:)?[a-z]+:[a-z:]+)['"]/g)) {
        if (!known.has(name)) suspicious.push(name)
      }
    }
    expect(suspicious).toEqual([])
  })
})

describe('происхождение размера контекстного окна доезжает до окна', () => {
  /**
   * Ловит оценку, ставшую измерением на границе main и renderer (2.6). Доля
   * заполнения выглядит одинаково правдоподобно в обоих случаях, а различает
   * их ровно одно поле — и оно проставляется здесь, там, где известно
   * происхождение знаменателя, а не там, где его рисуют.
   */
  it('написанное провайдером остаётся точным, выведенное — оценкой с причиной', () => {
    expect(toContext({ used: 129_200, window: 258_400, fill: 0.5, source: 'log' })).toEqual({
      used: 129_200,
      window: 258_400,
      fill: 0.5,
      confidence: 'exact',
    })

    const guessed = toContext({ used: 108_000, window: 1_000_000, fill: 0.108, source: 'observed' })
    expect(guessed.confidence).toBe('estimate')
    // Пометка без объяснения заставляет гадать, что именно неточно.
    expect(guessed.caveat).toBeTruthy()
  })
})
