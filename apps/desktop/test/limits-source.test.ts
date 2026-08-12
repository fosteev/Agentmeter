import { describe, expect, it } from 'vitest'
import { limitsSource } from '../src/main/snapshot.ts'

/**
 * Два источника лимитов → одна подпись над блоком в попапе (6.4).
 *
 * Кнопка там одна, и сводить два состояния приходится по худшему случаю.
 * Проверки названы поломкой: каждая ловит «среднее вместо худшего», а это
 * ровно тот класс ошибки, из-за которого подпись начинает обещать больше, чем
 * приложение знает.
 */

const CLAUDE_ONLY = {
  claude: { enabled: true, snapshot: { ts: 1_000, sessionId: '', source: 'oauth' as const } },
  codex: { enabled: false },
}

describe('свод источников', () => {
  it('оба выключены — источника нет', () => {
    expect(limitsSource({ claude: { enabled: false }, codex: { enabled: false } })).toEqual({
      enabled: false,
    })
  })

  it('включён любой один — кнопке есть что делать', () => {
    expect(limitsSource(CLAUDE_ONLY).enabled).toBe(true)
    expect(limitsSource({ claude: { enabled: false }, codex: { enabled: true } }).enabled).toBe(true)
  })

  /**
   * Ловит «возраст самого свежего». Подпись стоит над обоими окнами сразу, и
   * «спрошено 2 минуты назад» над окном четвертьчасовой давности — враньё,
   * ради недопущения которого блок и заведён.
   */
  it('возраст берётся у самого старого из ответов', () => {
    const source = limitsSource({
      claude: { enabled: true, snapshot: { ts: 5_000, sessionId: '', source: 'oauth' } },
      codex: { enabled: true, fetchedAt: 1_000 },
    })
    expect(source.askedAt).toBe(1_000)
  })

  /** Выключенный источник в счёт не идёт, даже если у него остался старый ответ. */
  it('выключенный источник не старит подпись', () => {
    const source = limitsSource({
      claude: { enabled: true, snapshot: { ts: 5_000, sessionId: '', source: 'oauth' } },
      codex: { enabled: false, fetchedAt: 1_000 },
    })
    expect(source.askedAt).toBe(5_000)
  })

  it('ни одного ответа — возраста нет вовсе', () => {
    expect(limitsSource({ claude: { enabled: true }, codex: { enabled: true } }).askedAt).toBe(
      undefined,
    )
  })

  /**
   * Ловит гашение кнопки из-за одного ограниченного источника. Пока второй
   * готов отвечать, кнопка обязана работать — иначе 429 у Anthropic отнимает
   * у человека и лимиты Codex.
   */
  it('ждать надо, только когда ограничены все включённые', () => {
    expect(
      limitsSource({
        claude: { enabled: true, retryAt: 9_000 },
        codex: { enabled: true },
      }).retryAt,
    ).toBe(undefined)

    expect(
      limitsSource({
        claude: { enabled: true, retryAt: 9_000 },
        codex: { enabled: true, retryAt: 4_000 },
      }).retryAt,
    ).toBe(4_000)
  })

  /** Ограничение выключенного источника кнопку не гасит. */
  it('выключенный источник не запирает кнопку', () => {
    expect(
      limitsSource({
        claude: { enabled: false, retryAt: 9_000 },
        codex: { enabled: true },
      }).retryAt,
    ).toBe(undefined)
  })
})
