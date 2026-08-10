/**
 * Заполнение контекстного окна живой сессии (2.6).
 *
 * Числитель измерен, знаменатель — нет, и вся честность этапа в том, чтобы их
 * не перепутать.
 *
 * **Числитель** — `contextTokens` последнего записанного запроса. Это весь
 * промпт, уехавший в API, то есть ровно то, чем занято окно; лежит в логе у
 * обоих провайдеров и берётся как есть.
 *
 * **Знаменатель** — размер окна модели, и он есть только у Codex.
 * `model_context_window` приезжает в каждом `token_count`, парсер его уже
 * кладёт в индекс (на живой машине — 11 750 запросов со значением 258 400), и
 * это число провайдера, а не наше.
 *
 * У Claude размера окна нет ни в транскрипте, ни в имени модели. Проверено по
 * всему `~/.claude`: `contextWindow` встречается в 8 файлах из 254, и все
 * восемь — чужой вывод команды `claude -p`, попавший в результат `Bash`. Имя
 * модели окно тоже не задаёт: строка `claude-opus-5` встречается с контекстом
 * до 495 548 токенов, то есть покрывает и окно 200k, и окно 1M — их выбирают
 * отдельными пунктами в интерфейсе, а в лог этот выбор не попадает.
 *
 * Поэтому у Claude знаменатель выводится из наблюдений: **окно не может быть
 * меньше самого большого контекста, который мы у этой модели видели**. Берётся
 * наименьшее стандартное окно, вмещающее наблюдавшийся максимум. Это оценка, и
 * она помечена оценкой; она самоисправляется на первой же длинной сессии и
 * ошибается только в меньшую сторону — то есть завышает заполнение, а не
 * успокаивает ложно.
 *
 * Где вывести не из чего — модели с непонятным окном, чужие эндпойнты через
 * Claude Code (`glm-5.2`, `qwen3.5-27b-32k`) — заполнения нет вовсе. Пустое
 * место честнее правдоподобной доли.
 */
import type { Db, SqlValue } from '../index/db.ts'

export interface ContextFill {
  /** Занято промптом последнего записанного запроса, токенов. Из лога. */
  used: number
  /** Размер окна, токенов. */
  window: number
  /** Доля занятого, 0..1. */
  fill: number
  /**
   * Откуда взят размер окна: `log` — написал провайдер, `observed` — выведен
   * из наблюдавшегося максимума. Второе показывается оценкой.
   */
  source: 'log' | 'observed'
}

/**
 * Стандартные окна Claude. Список короткий и намеренно не расширяется
 * «правдоподобными» промежуточными значениями: каждое здесь — то, что можно
 * выбрать в интерфейсе, а не то, что удобно подогнать под данные.
 */
export const CLAUDE_WINDOWS = [200_000, 1_000_000] as const

/**
 * За какой срок берётся наблюдавшийся максимум.
 *
 * Не за всю историю: сменивший план пользователь иначе навсегда останется с
 * окном, которого у него больше нет, и заполнение будет занижено — то есть
 * ошибка уедет в ту сторону, где она успокаивает.
 */
export const OBSERVED_WINDOW_DAYS = 30

/** По имени модели видно, что это Claude, — только для них работает лестница. */
function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-')
}

/** Наименьшее стандартное окно, вмещающее наблюдавшийся максимум. */
export function windowFromObserved(observedMax: number): number | undefined {
  return CLAUDE_WINDOWS.find((size) => size >= observedMax)
}

interface LastRequest {
  session_id: string
  used: number
  window: number | null
  model: string
}

/**
 * Заполнение окна для перечисленных сессий.
 *
 * Сессии здесь именно те, что показываются в трее, — по собственному
 * `session_id`, без свёртки сабагентов. У сабагента своё окно, и подмешивать
 * его в родителя значило бы показывать чужой контекст.
 */
export function collectContext(
  db: Db,
  ids: readonly string[],
  at: number,
): Map<string, ContextFill> {
  const out = new Map<string, ContextFill>()
  if (ids.length === 0) return out

  const marks = placeholders(ids.length)
  /*
   * Берётся последний запрос **из лога**: восстановленные (1.3) существуют
   * только как арифметика по разрыву цепочки кэша, и промпта у них нет — их
   * `contextTokens` посчитан, а не прочитан. Нулевой контекст отсекается там
   * же: синтетические записи CLI (`model: "<synthetic>"`) идут с нулём, и
   * последняя такая обнулила бы заполнение живой сессии.
   */
  const last = db.all<LastRequest>(
    `SELECT r.session_id AS session_id,
            r.context_tokens AS used,
            r.context_window AS window,
            r.model AS model
     FROM requests r
     JOIN (SELECT session_id, max(seq) AS seq
           FROM requests
           WHERE session_id IN (${marks}) AND origin = 'log' AND context_tokens > 0
           GROUP BY session_id) tail
       ON tail.session_id = r.session_id AND tail.seq = r.seq`,
    ...(ids as SqlValue[]),
  )
  if (last.length === 0) return out

  const needObserved = [
    ...new Set(
      last
        .filter((row) => row.window === null && isClaudeModel(row.model))
        .map((row) => row.model),
    ),
  ]
  const observed = observedMax(db, needObserved, at - OBSERVED_WINDOW_DAYS * 86_400_000)

  for (const row of last) {
    const fromLog = row.window !== null && row.window > 0
    const size = fromLog
      ? row.window!
      : isClaudeModel(row.model)
        ? // Собственный контекст сессии сюда подмешивать нечего: последний
          // запрос живого агента моложе срока наблюдений по построению, то есть
          // он уже посчитан в максимуме. `?? row.used` — страховка на пустой
          // ответ запроса, а не второе правило.
          windowFromObserved(observed.get(row.model) ?? row.used)
        : undefined
    if (size === undefined || size <= 0) continue
    out.set(row.session_id, {
      used: row.used,
      window: size,
      // Больше единицы доля не бывает даже при вранье источника: заполнение
      // сверх окна физически невозможно, а нарисованное — это уже не измерение.
      fill: Math.min(1, row.used / size),
      source: fromLog ? 'log' : 'observed',
    })
  }

  return out
}

function observedMax(db: Db, models: readonly string[], since: number): Map<string, number> {
  const out = new Map<string, number>()
  if (models.length === 0) return out
  const rows = db.all<{ model: string; mx: number }>(
    `SELECT model, max(context_tokens) AS mx
     FROM requests
     WHERE model IN (${placeholders(models.length)}) AND ts >= ?
     GROUP BY model`,
    ...(models as SqlValue[]),
    since,
  )
  for (const row of rows) out.set(row.model, row.mx)
  return out
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}
