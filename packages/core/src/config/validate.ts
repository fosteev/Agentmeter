/**
 * Что считается допустимым значением настройки (3.6).
 *
 * До 3.6 загрузчик проверял только тип: `"theme": "chartreuse"` и
 * `"locale": "de"` проходили молча, потому что обе строки — строки. Обещание в
 * шапке `load.ts` — «непонятные поля заменяются дефолтом, а список замен
 * возвращается» — при этом выполнялось наполовину: непонятное значение
 * доезжало до интерфейса и там либо ничего не делало, либо делало не то.
 *
 * Правила лежат отдельным списком, а не проверками внутри обхода, ради одной
 * вещи: путь, которого в конфиге нет, легко проверить тестом — а правило на
 * несуществующем пути это правило, которое никогда не сработает.
 */
import { DEFAULT_CONFIG } from './types.ts'

export interface Rule {
  ok(value: unknown): boolean
  /** Чего ждали — уходит в текст замечания. */
  expected: string
}

function oneOf(...values: readonly string[]): Rule {
  return { ok: (value) => values.includes(value as string), expected: values.join(' | ') }
}

/** Целое в диапазоне включительно. Дробное отвергается: часа 9.5 не бывает. */
function integer(from: number, to: number): Rule {
  return {
    ok: (value) => typeof value === 'number' && Number.isInteger(value) && value >= from && value <= to,
    expected: `целое ${from}..${to}`,
  }
}

/** Число в диапазоне либо `null` — «неизвестно», отдельное осмысленное значение. */
function numberOrNull(from: number, to: number): Rule {
  return {
    ok: (value) =>
      value === null || (typeof value === 'number' && Number.isFinite(value) && value >= from && value <= to),
    expected: `число ${from}..${to} или null`,
  }
}

/**
 * Путь настройки → правило. Ключи — те же точечные пути, что печатает
 * загрузчик в замечаниях, и на существование каждого стоит проверка
 * (`config.test.ts`): опечатка в пути даёт правило, которое молча ничего не
 * проверяет, — ровно тот класс вакуумной проверки, из-за которого в 3.0 и 3.2
 * зелёные тесты переживали мутацию.
 */
export const RULES: Record<string, Rule> = {
  'ui.theme': oneOf('system', 'light', 'dark'),
  'ui.locale': oneOf('system', 'ru', 'en'),
  // Час начала суток. 24 нет: это ноль следующего дня, и принимать оба
  // написания значит завести два имени одному значению.
  'ui.dayStartsAtHour': integer(0, 23),
  'alerts.warnAtPercent': integer(0, 100),
  'alerts.dangerAtPercent': integer(0, 100),
  // Ноль — «не уведомлять», это часть договора поля, а не край диапазона.
  'alerts.sessionTokenAlert': integer(0, Number.MAX_SAFE_INTEGER),
  'index.retentionDays': integer(0, 3650),
  // Опрос чаще, чем раз в 250 мс, съедает батарею и ничего не добавляет:
  // снимок стоит около 6 мс, но чтение хвостов логов — уже нет.
  'live.pollMs': integer(250, 60_000),
  'live.idleMs': integer(1_000, 24 * 3_600_000),
  'live.codexSilenceMs': integer(1_000, 24 * 3_600_000),
  'limits.claude.fiveHourCap': numberOrNull(0, Number.MAX_SAFE_INTEGER),
  'limits.claude.weeklyCap': numberOrNull(0, Number.MAX_SAFE_INTEGER),
  // Вес чтения кэша в лимите подписки: доля, а не множитель. У Codex измерено
  // ≈ 0.2 (1.8), у Claude открыто до 1.9 — но и там это доля.
  'limits.claude.cacheReadWeight': numberOrNull(0, 1),
}

/** Все пути правил существуют в дефолтном конфиге — иначе правило мёртвое. */
export function rulePathsInDefaults(): string[] {
  const missing: string[] = []
  for (const path of Object.keys(RULES)) {
    let node: unknown = DEFAULT_CONFIG
    for (const key of path.split('.')) {
      if (typeof node !== 'object' || node === null || !(key in node)) {
        missing.push(path)
        node = undefined
        break
      }
      node = (node as Record<string, unknown>)[key]
    }
  }
  return missing
}
