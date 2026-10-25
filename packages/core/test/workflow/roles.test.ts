import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/types.ts'
import { setLocale, t } from '../../src/i18n/index.ts'
import {
  ROLE_LABEL_KEYS,
  VERDICT_LABEL_KEYS,
  roleLabel,
  roleOf,
  verdictLabel,
  verdictOf,
  type WorkflowRole,
  type WorkflowRule,
} from '../../src/workflow/roles.ts'

/**
 * Роли и вердикты (9.2).
 *
 * Данные — живые: `agentType` с машины на 25 октября (866 сабагентов) и первые
 * строки ответов ревьюеров из discovery. Ожидания выписаны руками из брифа, а не
 * выводом реализации.
 */

const RULES = DEFAULT_CONFIG.workflow.roles
const VERDICTS = DEFAULT_CONFIG.workflow.verdicts

beforeEach(() => setLocale('ru'))

describe('roleOf — живые agentType с дефолтными правилами', () => {
  const live: Array<[string, WorkflowRole]> = [
    ['general-purpose', 'unknown'],
    ['workflow-subagent', 'unknown'],
    ['Explore', 'explore'],
    ['review-opus', 'reviewer'],
    ['plan-opus', 'planner'],
    ['exec-sonnet-high', 'executor'],
    ['exec-sonnet-medium', 'executor'],
    ['exec-sonnet-max', 'executor'],
    ['exec-opus-high', 'executor'],
  ]
  it.each(live)('%s → %s', (agentType, role) => {
    expect(roleOf(agentType, RULES)).toBe(role)
  })

  // Главное обещание этапа: неизвестный не становится исполнителем, а ровно
  // 663 из 866 живых сабагентов — general-purpose и workflow-subagent.
  it('неизвестный agentType — unknown, а не исполнитель', () => {
    for (const unknown of ['general-purpose', 'workflow-subagent', 'Plan', 'statusline-setup', 'x']) {
      expect(roleOf(unknown, RULES)).toBe('unknown')
    }
  })

  it('типа нет (корневая сессия, Codex) или он пуст — unknown, без падения', () => {
    expect(roleOf(null, RULES)).toBe('unknown')
    expect(roleOf(undefined, RULES)).toBe('unknown')
    expect(roleOf('', RULES)).toBe('unknown')
  })
})

describe('roleOf — шаблоны', () => {
  it('регистр учитывается: explore и PLAN-OPUS — не Explore и не plan-*', () => {
    expect(roleOf('explore', RULES)).toBe('unknown')
    expect(roleOf('PLAN-opus', RULES)).toBe('unknown')
    expect(roleOf('Review-opus', RULES)).toBe('unknown')
  })

  it('точное имя без звёздочки совпадает целиком, а не по подстроке', () => {
    expect(roleOf('Explore', RULES)).toBe('explore')
    expect(roleOf('Explore-2', RULES)).toBe('unknown')
    expect(roleOf('my-Explore', RULES)).toBe('unknown')
  })

  it('звёздочка — любая подстрока, в том числе пустая и с дефисами', () => {
    expect(roleOf('exec-', RULES)).toBe('executor')
    expect(roleOf('exec-a-b-c', RULES)).toBe('executor')
    const rules: WorkflowRule[] = [{ match: '*-opus', role: 'reviewer' }, { match: 'a*c*e', role: 'planner' }]
    expect(roleOf('review-opus', rules)).toBe('reviewer')
    expect(roleOf('abcde', rules)).toBe('planner')
    expect(roleOf('ae', rules)).toBe('unknown')
  })

  it('символы регулярки в шаблоне — буквальные, не оператор', () => {
    const rules: WorkflowRule[] = [
      { match: 'a.c', role: 'executor' },
      { match: 'x+y(1)', role: 'reviewer' },
      { match: '[ab]', role: 'planner' },
    ]
    expect(roleOf('a.c', rules)).toBe('executor')
    expect(roleOf('abc', rules)).toBe('unknown')
    expect(roleOf('x+y(1)', rules)).toBe('reviewer')
    expect(roleOf('xxy1', rules)).toBe('unknown')
    expect(roleOf('[ab]', rules)).toBe('planner')
    expect(roleOf('a', rules)).toBe('unknown')
  })

  it('побеждает первое совпавшее правило, а не самое точное', () => {
    const rules: WorkflowRule[] = [
      { match: 'exec-*', role: 'executor' },
      { match: 'exec-special', role: 'reviewer' },
    ]
    expect(roleOf('exec-special', rules)).toBe('executor')
    expect(roleOf('exec-special', [...rules].reverse())).toBe('reviewer')
  })

  it('пустой список правил — все unknown', () => {
    expect(roleOf('exec-sonnet-high', [])).toBe('unknown')
  })

  it('пользовательское правило добавляет роль для general-purpose', () => {
    const rules: WorkflowRule[] = [...RULES, { match: 'general-purpose', role: 'executor' }]
    expect(roleOf('general-purpose', rules)).toBe('executor')
  })
})

describe('verdictOf — живые первые строки ревьюеров', () => {
  const live: Array<[string, string]> = [
    ['**Принят с оговорками.**', 'notes'],
    ['принят  Исполнитель сделал…', 'accepted'],
    ['Вердикт: принят.**', 'accepted'],
    ['Этап 1 принят с оговорками', 'notes'],
  ]
  it.each(live)('%j → %s', (text, verdict) => {
    expect(verdictOf(text, VERDICTS)).toBe(verdict)
  })

  it('«не принят» — отказ, хотя содержит «принят»', () => {
    expect(verdictOf('**Не принят.** Тесты красные', VERDICTS)).toBe('rejected')
    expect(verdictOf('Этап 2 не принят', VERDICTS)).toBe('rejected')
    // Двойной и неразрывный пробел: голова хранится как написана.
    expect(verdictOf('не  принят', VERDICTS)).toBe('rejected')
    expect(verdictOf('не принят', VERDICTS)).toBe('rejected')
  })

  it('«принят с оговорками» — оговорки, хотя содержит «принят»', () => {
    expect(verdictOf('Принят с оговорками: нет теста', VERDICTS)).toBe('notes')
  })

  it('порядок rejected → notes → accepted: отказ с оговорками — всё равно отказ', () => {
    expect(verdictOf('Не принят, но с оговорками', VERDICTS)).toBe('rejected')
  })

  it('английский вариант', () => {
    expect(verdictOf('Accepted.', VERDICTS)).toBe('accepted')
    expect(verdictOf('Accepted with notes', VERDICTS)).toBe('notes')
    expect(verdictOf('Not accepted: tests fail', VERDICTS)).toBe('rejected')
    expect(verdictOf('REJECTED', VERDICTS)).toBe('rejected')
  })

  it('регистр не важен, ведущие пробелы и разметка не мешают', () => {
    expect(verdictOf('   \n  ПРИНЯТ', VERDICTS)).toBe('accepted')
    expect(verdictOf('## **принят**', VERDICTS)).toBe('accepted')
  })

  it('ничего не совпало — none', () => {
    expect(verdictOf('Смотрю дифф, нашёл три замечания…', VERDICTS)).toBe('none')
  })

  it('текста нет — none, а не падение на null', () => {
    expect(verdictOf(null, VERDICTS)).toBe('none')
    expect(verdictOf(undefined, VERDICTS)).toBe('none')
    expect(verdictOf('', VERDICTS)).toBe('none')
  })
})

describe('verdictOf — первые 200 знаков', () => {
  it('слово за 200-м знаком не считается', () => {
    const pad = 'я'.repeat(195)
    expect(verdictOf(`${pad} принят`, VERDICTS)).toBe('none')
    expect(verdictOf(`${pad.slice(5)} принят`, VERDICTS)).toBe('accepted')
  })

  // Срез по единицам UTF-16 дал бы 100 эмодзи на 200 единиц и отрезал слово.
  it('считаются кодпоинты, а не единицы UTF-16', () => {
    const text = '😀'.repeat(100) + 'принят'
    expect(text.length).toBe(206)
    expect(verdictOf(text, VERDICTS)).toBe('accepted')
  })

  it('отказ за 200-м знаком не перебивает принятие в голове', () => {
    expect(verdictOf('принят' + ' '.repeat(200) + 'не принят', VERDICTS)).toBe('accepted')
  })
})

// Приёмка 9.2: вердикт ищется в первой содержательной строке. На живом индексе
// он там у 24 ревьюеров из 24, а тело отчёта говорит о другом — и с порядком
// rejected → notes → accepted одна фраза в теле перебила бы вердикт.
describe('verdictOf — первая содержательная строка', () => {
  it('«не принято» в теле отчёта не перебивает вердикт первой строки', () => {
    expect(verdictOf('принят\n\nРешение по кэшу не принято, записал в pending', VERDICTS)).toBe('accepted')
    expect(verdictOf('**Принят.**\n\nОдин пункт принят с оговорками пользователя', VERDICTS)).toBe('accepted')
  })

  it('строки из одной разметки пропускаются', () => {
    expect(verdictOf('---\n**\n**Принят с оговорками.** Коммит 72be87d', VERDICTS)).toBe('notes')
    expect(verdictOf('\r\n  \r\nне принят', VERDICTS)).toBe('rejected')
  })

  it('вердикт ниже заголовка — none, а не выдуманный ответ', () => {
    expect(verdictOf('## Приёмка этапа 9.2\n\nпринят', VERDICTS)).toBe('none')
  })

  it('в голове одна разметка — none', () => {
    expect(verdictOf('---\n**', VERDICTS)).toBe('none')
  })
})

describe('verdictOf — свои регулярки', () => {
  it('применяются вместо дефолтных', () => {
    const own = { rejected: 'ВЕРНУТЬ', notes: 'ПРАВКИ', accepted: 'ОК' }
    expect(verdictOf('вернуть на доработку', own)).toBe('rejected')
    expect(verdictOf('ок, всё хорошо', own)).toBe('accepted')
    expect(verdictOf('принят', own)).toBe('none')
  })

  it('битая регулярка не роняет: на её месте дефолт', () => {
    const broken = { ...VERDICTS, accepted: '(не закрыта' }
    expect(() => verdictOf('принят', broken)).not.toThrow()
    expect(verdictOf('принят', broken)).toBe('accepted')
    expect(verdictOf('не принят', { ...VERDICTS, rejected: '[' })).toBe('rejected')
  })

  it('регулярка, совпадающая с пустой строкой, не делает всё отказом', () => {
    expect(verdictOf('что угодно', { ...VERDICTS, rejected: '' })).toBe('none')
    expect(verdictOf('что угодно', { ...VERDICTS, rejected: 'a*' })).toBe('none')
  })
})

describe('подписи — ключи, а не строки', () => {
  it('у каждой роли и вердикта есть перевод на обоих языках', () => {
    for (const lng of ['ru', 'en'] as const) {
      setLocale(lng)
      for (const role of Object.keys(ROLE_LABEL_KEYS) as WorkflowRole[]) {
        expect(roleLabel(role)).not.toBe(ROLE_LABEL_KEYS[role])
        expect(roleLabel(role).length).toBeGreaterThan(0)
      }
      for (const key of Object.values(VERDICT_LABEL_KEYS)) {
        expect(t(key)).not.toBe(key)
      }
    }
    setLocale('ru')
    expect(roleLabel('unknown')).toBe('Роль не определена')
    expect(verdictLabel('rejected')).toBe('Не принято')
    setLocale('en')
    expect(roleLabel('unknown')).toBe('Role not determined')
  })
})
