import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectContext, OBSERVED_WINDOW_DAYS } from '../../src/live/context.ts'
import { openDb, type Db } from '../../src/index/db.ts'

/**
 * Заполнение контекстного окна (2.6).
 *
 * Проверяется не арифметика деления, а происхождение знаменателя: у Codex его
 * пишет провайдер, у Claude его нет вовсе. Ошибка здесь тихая — доля
 * нарисуется одинаково правдоподобной в обоих случаях.
 */

const AT = 1_786_439_520_000
const DAY = 86_400_000

let tmp: string
let db: Db

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agentmeter-context-'))
  db = openDb(join(tmp, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function session(id: string, provider: 'claude' | 'codex'): void {
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at)
     VALUES (?, ?, ?, '/proj', 'proj', ?, ?)`,
    id,
    provider,
    `/logs/${id}.jsonl`,
    AT - DAY,
    AT,
  )
}

interface RequestRow {
  seq: number
  model: string
  context: number
  window?: number | null
  ts?: number
  origin?: string
}

function request(sessionId: string, row: RequestRow): void {
  db.run(
    `INSERT INTO requests (session_id, seq, request_id, ts, model, context_tokens, context_window, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    row.seq,
    `req-${sessionId}-${row.seq}`,
    row.ts ?? AT - 60_000,
    row.model,
    row.context,
    row.window ?? null,
    row.origin ?? 'log',
  )
}

describe('заполнение контекстного окна', () => {
  /**
   * Ловит потерянный знаменатель провайдера. `model_context_window` Codex
   * пишет в каждый `token_count`, парсер кладёт его в индекс — и если брать
   * вместо него нашу лестницу, точное число молча станет оценкой.
   */
  it('у Codex размер окна берётся из лога и помечен измеренным', () => {
    session('cx', 'codex')
    request('cx', { seq: 1, model: 'gpt-5.5', context: 64_600, window: 258_400 })
    request('cx', { seq: 2, model: 'gpt-5.5', context: 129_200, window: 258_400 })

    const fill = collectContext(db, ['cx'], AT).get('cx')
    expect(fill).toEqual({ used: 129_200, window: 258_400, fill: 0.5, source: 'log' })
  })

  /**
   * Ловит главную ошибку этапа: окно Claude, взятое по имени модели. Одна и та
   * же строка `claude-opus-5` встречается и с окном 200k, и с окном 1M —
   * выбирают их отдельными пунктами интерфейса, а в лог это не попадает.
   * Единственное, что мы знаем наверняка: окно не меньше наблюдавшегося
   * максимума.
   */
  it('у Claude размер окна поднимается до наблюдавшегося максимума', () => {
    session('small', 'claude')
    request('small', { seq: 1, model: 'claude-opus-5', context: 90_000 })

    // Пока ничего длинного не видели — наименьшее стандартное окно.
    expect(collectContext(db, ['small'], AT).get('small')).toEqual({
      used: 90_000,
      window: 200_000,
      fill: 0.45,
      source: 'observed',
    })

    // Другая сессия той же модели переросла 200k — значит окно у модели больше,
    // и первая сессия обязана пересчитаться вместе с ней.
    session('long', 'claude')
    request('long', { seq: 1, model: 'claude-opus-5', context: 495_548 })

    const both = collectContext(db, ['small', 'long'], AT)
    expect(both.get('small')!.window).toBe(1_000_000)
    expect(both.get('long')!.window).toBe(1_000_000)
    expect(both.get('small')!.source).toBe('observed')
  })

  /**
   * Ловит вечное окно после смены плана: наблюдение годичной давности
   * поднимало бы знаменатель навсегда, а ошибка знаменателя вверх — это
   * заниженное заполнение, то есть та сторона, где неправда успокаивает.
   */
  it('старые наблюдения в оценку окна не идут', () => {
    session('old', 'claude')
    request('old', {
      seq: 1,
      model: 'claude-opus-5',
      context: 495_548,
      ts: AT - (OBSERVED_WINDOW_DAYS + 1) * DAY,
    })
    session('now', 'claude')
    request('now', { seq: 1, model: 'claude-opus-5', context: 120_000 })

    expect(collectContext(db, ['now'], AT).get('now')!.window).toBe(200_000)
  })

  /**
   * Ловит долю, посчитанную от выдуманного окна. Через Claude Code ходят чужие
   * эндпойнты (`glm-5.2`, `qwen3.5-27b-32k`), и лестница Claude им не указ:
   * показать там 14% значит соврать ровно тем числом, ради честности которого
   * продукт и затевался.
   */
  it('у чужой модели без размера окна заполнения нет вовсе', () => {
    session('alien', 'claude')
    request('alien', { seq: 1, model: 'glm-5.2', context: 28_000 })

    expect(collectContext(db, ['alien'], AT).has('alien')).toBe(false)
  })

  /**
   * Ловит обнулённое заполнение живой сессии. Синтетические записи CLI идут с
   * нулевым контекстом, а восстановленные запросы (1.3) промпта не имеют
   * вовсе — их `contextTokens` посчитан, а не прочитан. Окажись такая запись
   * последней, указатель показал бы пустое окно у работающего агента.
   */
  it('последним считается записанный запрос с непустым контекстом', () => {
    session('tail', 'claude')
    request('tail', { seq: 1, model: 'claude-opus-5', context: 150_000 })
    request('tail', { seq: 2, model: 'claude-opus-5', context: 190_000, origin: 'reconstructed' })
    request('tail', { seq: 3, model: '<synthetic>', context: 0 })

    expect(collectContext(db, ['tail'], AT).get('tail')!.used).toBe(150_000)
  })

  /**
   * Ловит чужой контекст в родительской строке. Расход сабагентов сворачивается
   * в родителя (так и надо), но окно у сабагента своё, и свернуть его туда же
   * значит показать заполнение чужой сессии.
   */
  it('контекст сабагента в родителя не сворачивается', () => {
    session('parent', 'claude')
    request('parent', { seq: 1, model: 'claude-opus-5', context: 60_000 })
    db.run(
      `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at, parent_session_id)
       VALUES ('kid', 'claude', '/logs/kid.jsonl', '/proj', 'proj', ?, ?, 'parent')`,
      AT - DAY,
      AT,
    )
    request('kid', { seq: 1, model: 'claude-opus-5', context: 180_000 })

    expect(collectContext(db, ['parent'], AT).get('parent')!.used).toBe(60_000)
  })
})
