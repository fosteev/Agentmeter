/**
 * Кем был субагент и чем кончилась приёмка (9.2).
 *
 * Обе функции чистые и ничего не читают из конфига сами: правила и регулярки
 * приходят аргументами. Так их зовут и 9.3 (запрос), и тесты — без загрузчика.
 *
 * **Вердикт считается при запросе, а не при разборе.** Индекс хранит голову
 * ответа как написана (`sessions.last_text_head`, 9.1), а регулярки из конфига
 * применяются здесь: смена настройки не требует переиндекса.
 */
import { t } from '../i18n/index.ts'
import {
  DEFAULT_CONFIG,
  type Verdict,
  type WorkflowConfig,
  type WorkflowRole,
  type WorkflowRule,
} from '../config/types.ts'

export type { Verdict, WorkflowConfig, WorkflowRole, WorkflowRule }

/** Подписи — ключи, а не строки: `t()` на верхнем уровне застыл бы на языке запуска. */
export const ROLE_LABEL_KEYS = {
  executor: 'workflow.roleExecutor',
  reviewer: 'workflow.roleReviewer',
  planner: 'workflow.rolePlanner',
  explore: 'workflow.roleExplore',
  unknown: 'workflow.roleUnknown',
} as const satisfies Record<WorkflowRole, string>

export const VERDICT_LABEL_KEYS = {
  accepted: 'workflow.verdictAccepted',
  notes: 'workflow.verdictNotes',
  rejected: 'workflow.verdictRejected',
  none: 'workflow.verdictNone',
} as const satisfies Record<Verdict, string>

export function roleLabel(role: WorkflowRole): string {
  return t(ROLE_LABEL_KEYS[role])
}

export function verdictLabel(verdict: Verdict): string {
  return t(VERDICT_LABEL_KEYS[verdict])
}

const globCache = new Map<string, RegExp>()

/** Шаблон только с `*`: всё остальное — буквальные символы, регистр учитывается. */
function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob)
  if (re === undefined) {
    const body = glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\\-/]/g, '\\$&'))
      .join('[\\s\\S]*')
    re = new RegExp(`^${body}$`)
    globCache.set(glob, re)
  }
  return re
}

/**
 * Роль по `agentType`: первое совпавшее правило. Ничего не совпало, типа нет
 * (`null` — у корневых сессий) или он пуст — `unknown`, и ни в коем случае не
 * исполнитель: `general-purpose` и `workflow-subagent` — это 75% живых
 * сабагентов, и приписать их исполнителю значит выдумать знаменатель доли
 * переделки.
 */
export function roleOf(agentType: string | null | undefined, rules: readonly WorkflowRule[]): WorkflowRole {
  if (typeof agentType !== 'string' || agentType === '') return 'unknown'
  for (const rule of rules) {
    if (globToRegExp(rule.match).test(agentType)) return rule.role
  }
  return 'unknown'
}

/** Сколько знаков головы смотрим. Хранится столько же, но функцию зовут и с чужим текстом. */
const HEAD = 200

const regexCache = new Map<string, RegExp | null>()

function compile(source: string): RegExp | null {
  let re = regexCache.get(source)
  if (re === undefined) {
    try {
      re = new RegExp(source, 'i')
    } catch {
      re = null
    }
    regexCache.set(source, re)
  }
  return re
}

/** Годная регулярка из присланной, иначе дефолтная: битая не роняет main и не молчит вердиктом. */
function patternFor(kind: keyof WorkflowConfig['verdicts'], patterns: WorkflowConfig['verdicts']): RegExp {
  const own = compile(patterns[kind])
  if (own !== null && !own.test('')) return own
  return compile(DEFAULT_CONFIG.workflow.verdicts[kind]) as RegExp
}

/**
 * Первые 200 **кодпоинтов**: так их режет разбор (9.1), и срез по единицам
 * UTF-16 разрезал бы суррогатную пару посреди.
 */
function head(text: string): string {
  if (text.length <= HEAD) return text
  return Array.from(text).slice(0, HEAD).join('')
}

/** Первая строка, где есть буква или цифра: строки из одной разметки (`---`, `**`) пропускаются. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (/[\p{L}\p{N}]/u.test(line)) return line
  }
  return ''
}

/**
 * Вердикт приёмки по голове последнего ответа ревьюера.
 *
 * Порядок `rejected → notes → accepted` обязателен: «не принят» содержит
 * «принят», а «принят с оговорками» — тоже. Поиск по подстроке, без `^`: голова
 * хранится как написана, с разметкой и ведущими пробелами (`**Принят с
 * оговорками.**`, `**Вердикт:** принят`, `Этап 1 принят`). Текста нет (`null` —
 * корневая сессия, Codex, ответ без текста; на живой машине 7 ревьюеров из 35)
 * — `none`, не падение.
 *
 * **Ищется только в первой содержательной строке** (первой, где есть буква или
 * цифра): вердикт пишут первой строкой, а тело отчёта говорит о другом. Без
 * этого «принят\n\nрешение по кэшу не принято» стало бы отказом — порядок
 * проверки отдаёт первенство `rejected`, и одна фраза в теле перебила бы
 * вердикт. Замер приёмки 9.2 на живом индексе: у 24 из 24 ревьюеров с вердиктом
 * он стоит в первой строке. Вердикт ниже заголовка (`## Приёмка\n\nпринят`)
 * даёт `none` — видимое «вердикта нет», а не выдуманный отказ.
 *
 * Известный предел: подстрока. «Принятые решения…» в первой строке совпадёт с
 * «принят», и `\b` с кириллицей не работает — границы слова в JS только ASCII.
 * Регулярка пользователя с катастрофическим бэктрекингом повесит main: вход
 * ограничен 200 знаками и одной строкой, шаблон — 200 знаками, а запретить
 * такой класс без разбора регулярки нечем; источник — собственный конфиг.
 */
export function verdictOf(text: string | null | undefined, patterns: WorkflowConfig['verdicts']): Verdict {
  if (typeof text !== 'string' || text === '') return 'none'
  const sample = firstLine(head(text))
  if (sample === '') return 'none'
  if (patternFor('rejected', patterns).test(sample)) return 'rejected'
  if (patternFor('notes', patterns).test(sample)) return 'notes'
  if (patternFor('accepted', patterns).test(sample)) return 'accepted'
  return 'none'
}
