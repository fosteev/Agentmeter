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
import { t } from '../i18n/index.ts'
import { DEFAULT_CONFIG } from './types.ts'

export interface Rule {
  ok(value: unknown): boolean
  /**
   * Чего ждали — уходит в текст замечания. Функцией, когда текст переводится:
   * `t()` на верхнем уровне модуля застыл бы на языке запуска.
   */
  expected: string | (() => string)
}

/** Текст «чего ждали» — строкой, как бы правило его ни задавало. */
export function expectedText(rule: Rule): string {
  return typeof rule.expected === 'function' ? rule.expected() : rule.expected
}

function oneOf(...values: readonly string[]): Rule {
  return { ok: (value) => values.includes(value as string), expected: values.join(' | ') }
}

/** Целое в диапазоне включительно. Дробное отвергается: часа 9.5 не бывает. */
function integer(from: number, to: number): Rule {
  return {
    ok: (value) => typeof value === 'number' && Number.isInteger(value) && value >= from && value <= to,
    expected: () => t('config.expectedInteger', { from, to }),
  }
}

/** Число в диапазоне либо `null` — «неизвестно», отдельное осмысленное значение. */
function numberOrNull(from: number, to: number): Rule {
  return {
    ok: (value) =>
      value === null || (typeof value === 'number' && Number.isFinite(value) && value >= from && value <= to),
    expected: () => t('config.expectedNumberOrNull', { from, to }),
  }
}

/** Потолок длины регулярки и шаблона: пользовательский текст не должен быть простынёй. */
const MAX_PATTERN = 200

/**
 * Регулярка вердикта: компилируется с флагом `i`, непустая и не совпадает с
 * пустой строкой.
 *
 * Последнее — не придирка. `''`, `a*` или `(?:)` совпадают с любым текстом, и
 * вердикт всех приёмок молча стал бы `rejected`: каждая проверка прошла бы, а
 * экран показал бы выдуманный отказ.
 */
export function compilesAsVerdict(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATTERN) return false
  try {
    return !new RegExp(value, 'i').test('')
  } catch {
    return false
  }
}

const verdictPattern: Rule = {
  ok: compilesAsVerdict,
  expected: () => t('config.expectedRegex', { max: MAX_PATTERN }),
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
  'workflow.verdicts.rejected': verdictPattern,
  'workflow.verdicts.notes': verdictPattern,
  'workflow.verdicts.accepted': verdictPattern,
  // Окно в один цикл законно (точка = цикл), сверху — потолок здравого смысла:
  // за пять недель замера циклов было 44.
  'workflow.window.cycles': integer(1, 1_000),
  'workflow.window.sessions': integer(1, 100_000),
  // Доли, не проценты (см. `WorkflowConfig`). Накладные — кратность, она бывает
  // больше единицы: главная сессия и ревьюер вместе могут стоить втрое больше
  // исполнителя.
  'workflow.target.rework': numberOrNull(0, 1),
  'workflow.alerts.rework': numberOrNull(0, 1),
  'workflow.alerts.errorRate': numberOrNull(0, 1),
  'workflow.alerts.overhead': numberOrNull(0, 1_000),
}

const ROLES = ['executor', 'reviewer', 'planner', 'explore'] as const

/**
 * Списки объектов — `workflow.roles`.
 *
 * Обход конфига знает только объекты, скаляры и списки строк; список объектов
 * ему не по форме, и без отдельного обработчика `roles` отвергался бы целиком
 * как «не список строк» — а значит, свои роли пользователь задать не мог бы.
 * Обработчик получает присланный **массив** и возвращает годное: негодный
 * элемент выбрасывается по одному с замечанием, а не весь список — порядок
 * правил значим, и потеря одной опечатки не должна стирать остальные.
 */
export const SHAPES: Record<string, (got: unknown[], path: string, problems: string[]) => unknown[]> = {
  'workflow.roles': (got, path, problems) => {
    const out: Array<{ match: string; role: string }> = []
    got.forEach((item, index) => {
      if (isRoleRule(item)) {
        out.push({ match: item.match, role: item.role })
        return
      }
      problems.push(t('config.badRoleRule', { path: `${path}[${index}]`, got: JSON.stringify(item) ?? String(item) }))
    })
    return out
  },
}

function isRoleRule(item: unknown): item is { match: string; role: string } {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
  const { match, role } = item as Record<string, unknown>
  return (
    typeof match === 'string' &&
    match.length > 0 &&
    match.length <= MAX_PATTERN &&
    typeof role === 'string' &&
    (ROLES as readonly string[]).includes(role)
  )
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
