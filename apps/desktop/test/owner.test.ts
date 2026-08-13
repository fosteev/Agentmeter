import { describe, expect, it, vi } from 'vitest'
import type { LiveSession, OwnerApp } from '@agentmeter/core'
import { createOwnerBook } from '../src/main/owner.ts'

/**
 * Какое приложение открыть по клику на уведомлении (7.6).
 *
 * Проверки названы по поломке. Все три — про то, что узнать программу надо
 * **при жизни агента**: в момент уведомления «закончил» процесса уже нет, и
 * книжка, которая спрашивает `ps` тогда же, работает ровно в тех случаях, где
 * уведомление и не нужно.
 */

const CURSOR: OwnerApp = { bundle: '/Applications/Cursor.app', name: 'Cursor' }

function session(sessionId: string, pid: number): LiveSession {
  return {
    pid,
    sessionId,
    provider: 'claude',
    cwd: '/Users/fost/Projects/Agentmeter',
    startedAt: 1_786_610_651_244,
    entrypoint: 'vscode',
  }
}

describe('createOwnerBook', () => {
  it('поднимает программу сессии, а не первую попавшуюся', async () => {
    const activate = vi.fn(async () => {})
    const book = createOwnerBook({
      sessions: () => [session('a', 28496), session('b', 9089)],
      owners: (pids) => new Map(pids.includes(28496) ? [[28496, CURSOR]] : []),
      activate,
    })

    book.learn(['a', 'b'])

    expect(await book.reveal('a')).toBe(true)
    expect(activate).toHaveBeenCalledWith('/Applications/Cursor.app')
    // Сессия из того же реестра, но без владельца, — честное «не знаем».
    expect(await book.reveal('b')).toBe(false)
    expect(activate).toHaveBeenCalledTimes(1)
  })

  /**
   * Ловит попытку спросить `ps` в момент клика. `done` в снимке означает, что
   * процесса уже нет, — а это и есть уведомление «агент закончил», ради
   * которого всё затевалось.
   */
  it('владелец переживает смерть сессии', async () => {
    const sessions = vi.fn(() => [session('a', 28496)])
    const book = createOwnerBook({
      sessions,
      owners: () => new Map([[28496, CURSOR]]),
      activate: async () => {},
    })

    book.learn(['a'])
    sessions.mockReturnValue([])

    expect(book.lookup('a')).toEqual(CURSOR)
    expect(await book.reveal('a')).toBe(true)
  })

  /**
   * Ловит чтение реестра на каждом опросе. Опрос идёт раз в секунду, и сессии
   * между тиками те же самые: без отсечения известных это каталог, десяток
   * файлов и запуск `ps` ежесекундно ради неизменного ответа.
   */
  it('о знакомых сессиях не спрашивает второй раз', () => {
    const sessions = vi.fn(() => [session('a', 28496)])
    const owners = vi.fn(() => new Map([[28496, CURSOR]]))
    const book = createOwnerBook({ sessions, owners, activate: async () => {} })

    book.learn(['a'])
    book.learn(['a'])
    book.learn(['a'])

    expect(sessions).toHaveBeenCalledTimes(1)
    expect(owners).toHaveBeenCalledTimes(1)
  })

  /** То же и про сессии без владельца: «не узнали» — тоже знание. */
  it('неудачу запоминает, а не переспрашивает', () => {
    const sessions = vi.fn((): LiveSession[] => [])
    const book = createOwnerBook({ sessions, owners: () => new Map(), activate: async () => {} })

    book.learn(['codex-1'])
    book.learn(['codex-1'])

    expect(sessions).toHaveBeenCalledTimes(1)
    expect(book.lookup('codex-1')).toBeUndefined()
  })

  /**
   * Ловит `reveal`, отвечающий «открыл» после отказа `open`. Приложение могли
   * снести или переименовать, и тогда клик обязан привести хоть куда-то — своё
   * окно открывает вызвавший, но только если ему сказали правду.
   */
  it('отказ open — это не «открыл»', async () => {
    const book = createOwnerBook({
      sessions: () => [session('a', 28496)],
      owners: () => new Map([[28496, CURSOR]]),
      activate: async () => {
        throw new Error('The application cannot be found.')
      },
    })

    book.learn(['a'])

    expect(await book.reveal('a')).toBe(false)
  })

  it('повод без сессии владельца не ищет', async () => {
    const sessions = vi.fn((): LiveSession[] => [])
    const book = createOwnerBook({ sessions, owners: () => new Map(), activate: async () => {} })

    expect(await book.reveal(undefined)).toBe(false)
    expect(sessions).not.toHaveBeenCalled()
  })

  /**
   * Ловит множество без потолка. Оно живёт весь сеанс приложения, и на машине
   * с десятком чатов в день это тысячи записей о давно закрытых программах.
   */
  it('помнит последние сессии, а не все подряд', () => {
    const all = Array.from({ length: 250 }, (_, i) => session(`s${i}`, 1000 + i))
    const book = createOwnerBook({
      sessions: () => all,
      owners: (pids) => new Map(pids.map((pid) => [pid, CURSOR])),
      activate: async () => {},
    })

    for (const item of all) book.learn([item.sessionId])

    expect(book.lookup('s0')).toBeUndefined()
    expect(book.lookup('s249')).toEqual(CURSOR)
  })
})
