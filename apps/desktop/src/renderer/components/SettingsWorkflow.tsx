import type { CSSProperties, ReactNode } from 'react'
import type { AssignableRole, Config, Verdict, WorkflowRule } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { MONO, roleName, verdictName } from '../workflow.ts'
import { SectionTitle } from './SectionTitle.tsx'
import { Switch } from './Switch.tsx'

/**
 * «Workflow» в настройках — строки 2953–3063 макета (раздел 13, 9.5).
 *
 * Шестой раздел после «Приватности». Правка — обычный `config:set`, особых
 * каналов нет; что здесь важно знать про конфиг (9.2):
 *
 * - **`roles` — список объектов, правка заменяет его целиком**, порядок значим
 *   (побеждает первое правило). Стрелки двигают правило и шлют весь список.
 * - **Цель и пороги — доли 0..1**, кратность накладных до 1000. Поле показывает
 *   проценты, а в конфиг пишет долю; округление — при показе, не при записи, и
 *   запись идёт только по изменённому полю (нетронутое поле назад не пишется).
 *   Пустое поле — `null`: цели или порога нет.
 * - **Сервер вправе отвергнуть** регулярку, окно, правило. Ответ приходит с
 *   замечаниями, и раздел показывает те из них, что про него (`workflow.…`):
 *   считать ответ принятым нельзя. Отвергнутое значение откатывается к текущему
 *   — поле после ответа перерисовывается заново.
 * - Подписи ролей и вердиктов — готовые, из каталога (9.2); четыре назначаемые
 *   роли — `AssignableRole`, `unknown` назначить нельзя.
 *
 * Поля — неуправляемые (`defaultValue`) и правят конфиг по уходу фокуса или
 * Enter: правка на каждый символ слала бы `0.0` по пути к `0.05`, а сервер ответил
 * бы замечанием на промежуточный ввод. Состояния в разделе нет вовсе — как у
 * остальных настроек: окно получает конфиг, возвращает правку и перерисовывается
 * ответом.
 */
export interface SettingsWorkflowProps {
  config: Config
  /** Замечания сервера ко всему файлу настроек; раздел берёт свои. */
  problems: readonly string[]
  onChange: (patch: DeepPartial<Config>) => void
}

/**
 * Длина шаблона — та же граница, что `MAX_PATTERN` в `config/validate.ts`. Поле
 * длиннее не пускает: правило роли сервер с длинным шаблоном выбросит целиком, и
 * правка шаблона удалила бы само правило.
 */
export const PATTERN_MAX = 200

/** Четыре назначаемые роли в порядке макета. */
export const ASSIGNABLE: readonly AssignableRole[] = ['executor', 'reviewer', 'planner', 'explore']

/** Порядок проверки вердиктов — тот же, что в ядре: «не принят» содержит «принят». */
const VERDICTS = ['rejected', 'notes', 'accepted'] as const satisfies readonly Exclude<
  Verdict,
  'none'
>[]

const caps = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--tx3)',
} as const

const hint = { fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.5 } as const

// ─── перевод между полем и конфигом ───────────────────────────────────────────

/** Доля 0.2 → «20». Знаков до двух: больше поле не показывает, а нетронутое назад не пишется. */
export function shareToField(share: number | null): string {
  return share === null ? '' : String(Number((share * 100).toFixed(2)))
}

/** Кратность 3 → «3»; нет порога → пусто. */
export function multipleToField(value: number | null): string {
  return value === null ? '' : String(value)
}

/**
 * Текст поля → число. `undefined` — не число (оставить как было), `null` —
 * пусто (цели нет). Запятая считается разделителем: в русской раскладке она
 * под рукой.
 */
export function parseField(text: string): number | null | undefined {
  const cleaned = text.trim().replace(',', '.')
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

/** Проценты → доля 0..1 без хвоста плавающей точки: 33.3 / 100 это 0.33299999999999996, а пишем 0.333. */
export function fieldToShare(percent: number): number {
  return Number((percent / 100).toPrecision(12))
}

/** Правило из формы «+ правило»; пустой шаблон или чужая роль — не правило. */
export function newRule(form: FormData): WorkflowRule | null {
  const match = String(form.get('match') ?? '').trim()
  const role = String(form.get('role') ?? '')
  if (match === '' || !(ASSIGNABLE as readonly string[]).includes(role)) return null
  return { match, role: role as AssignableRole }
}

/** Замечания раздела: путь ключа стоит в начале строки (`workflow.roles[1]: …`). */
export function workflowProblems(problems: readonly string[]): string[] {
  return problems.filter((problem) => problem.startsWith('workflow.'))
}

// ─── раздел ───────────────────────────────────────────────────────────────────

export function SettingsWorkflow({ config, problems, onChange }: SettingsWorkflowProps) {
  const { workflow } = config
  const own = workflowProblems(problems)
  // Часть ключа поля: ответ с другими замечаниями перерисовывает поля заново, и
  // отвергнутый ввод не остаётся на экране под видом принятого.
  const epoch = own.join('\n')

  const setRoles = (roles: WorkflowRule[]): void => onChange({ workflow: { roles } })
  const replaceRule = (index: number, rule: WorkflowRule): void =>
    setRoles(workflow.roles.map((item, at) => (at === index ? rule : item)))
  const move = (index: number, by: -1 | 1): void => {
    const next = [...workflow.roles]
    const [rule] = next.splice(index, 1)
    next.splice(index + by, 0, rule!)
    setRoles(next)
  }

  return (
    <div
      data-workflow-settings
      style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
    >
      {own.length === 0 ? null : (
        <div data-workflow-problems style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionTitle title={t('settings.problems')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {own.map((problem) => (
              <div
                key={problem}
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: 'var(--warn)',
                  padding: '8px 12px',
                  background: 'var(--s1)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                }}
              >
                {problem}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* «Workflow выключен» живёт здесь, а не на вкладке: выключенной вкладки в окне нет. */}
      {workflow.enabled ? null : (
        <div
          data-workflow-off
          style={{
            border: '1px dashed var(--line)',
            borderRadius: 12,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13 }}>{t('workflow.offTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
            {t('workflow.offText')}
          </div>
        </div>
      )}

      <Switch
        name="workflowEnabled"
        label={t('workflow.setEnabled')}
        note={t('workflow.setEnabledNote')}
        checked={workflow.enabled}
        onChange={(value) => onChange({ workflow: { enabled: value } })}
      />

      <Group title={t('workflow.setRolesTitle')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {workflow.roles.map((rule, index) => (
            <div
              key={`${index}:${rule.match}:${rule.role}`}
              data-workflow-rule={index}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr 160px 48px',
                gap: 12,
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--s1)',
                border: '1px solid var(--line)',
                borderRadius: 6,
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--tx3)' }}>
                {index + 1}
              </span>
              <TextField
                name={`workflowRule${index}`}
                label={t('workflow.setRulePattern')}
                value={rule.match}
                epoch={epoch}
                mono
                onCommit={(match) => {
                  // Пустой шаблон — не правило; удалять правило есть кнопка.
                  if (match.trim() !== '') replaceRule(index, { ...rule, match: match.trim() })
                }}
              />
              <RoleSelect
                name={`workflowRole${index}`}
                label={t('workflow.setRuleRole')}
                value={rule.role}
                onChange={(role) => replaceRule(index, { ...rule, role })}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                <Action
                  name="up"
                  label={t('workflow.setRuleUp')}
                  glyph="↑"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <Action
                  name="down"
                  label={t('workflow.setRuleDown')}
                  glyph="↓"
                  disabled={index === workflow.roles.length - 1}
                  onClick={() => move(index, 1)}
                />
                <Action
                  name="remove"
                  label={t('workflow.setRuleRemove')}
                  glyph="×"
                  onClick={() => setRoles(workflow.roles.filter((_, at) => at !== index))}
                />
              </div>
            </div>
          ))}
          <form
            data-workflow-add
            onSubmit={(event) => {
              event.preventDefault()
              const rule = newRule(new FormData(event.currentTarget))
              if (rule === null) return
              setRoles([...workflow.roles, rule])
              event.currentTarget.reset()
            }}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 160px',
              gap: 12,
              alignItems: 'center',
              padding: '8px 12px',
              border: '1px dashed var(--line)',
              borderRadius: 6,
            }}
          >
            <input
              name="match"
              data-setting="workflowRuleNew"
              aria-label={t('workflow.setAddRule')}
              placeholder={t('workflow.setAddRule')}
              maxLength={PATTERN_MAX}
              spellCheck={false}
              autoComplete="off"
              style={bare({ mono: true })}
            />
            <select
              name="role"
              defaultValue="executor"
              aria-label={t('workflow.setRuleRole')}
              style={roleStyle}
            >
              {ASSIGNABLE.map((role) => (
                <option key={role} value={role}>
                  {roleName(role)}
                </option>
              ))}
            </select>
          </form>
        </div>
        <span style={hint}>{t('workflow.setRulesNote')}</span>
      </Group>

      <Group title={t('workflow.setVerdictTitle')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {VERDICTS.map((key) => (
            <div
              key={key}
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr',
                gap: 12,
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 12.5 }}>{verdictName(key)}</span>
              <TextField
                name={`workflowVerdict-${key}`}
                label={verdictName(key)}
                value={workflow.verdicts[key]}
                epoch={epoch}
                mono
                box
                onCommit={(pattern) => onChange({ workflow: { verdicts: { [key]: pattern } } })}
              />
            </div>
          ))}
        </div>
        <span style={hint}>{t('workflow.setVerdictNote')}</span>
      </Group>

      <Group title={t('workflow.setWindowTitle')}>
        <Fields>
          <NumberField
            name="workflowWindowCycles"
            label={t('workflow.setWindowCycles')}
            value={String(workflow.window.cycles)}
            unit={t('workflow.setUnitCycles', { count: workflow.window.cycles })}
            epoch={epoch}
            filled
            onCommit={(value) => value !== null && onChange({ workflow: { window: { cycles: value } } })}
          />
          <NumberField
            name="workflowWindowSessions"
            label={t('workflow.setWindowSessions')}
            value={String(workflow.window.sessions)}
            unit={t('workflow.setUnitSessions', { count: workflow.window.sessions })}
            epoch={epoch}
            filled
            onCommit={(value) =>
              value !== null && onChange({ workflow: { window: { sessions: value } } })
            }
          />
          <NumberField
            name="workflowTarget"
            label={t('workflow.setTarget')}
            value={shareToField(workflow.target.rework)}
            prefix="≤"
            unit="%"
            epoch={epoch}
            filled
            nullable
            onCommit={(value) =>
              onChange({
                workflow: { target: { rework: value === null ? null : fieldToShare(value) } },
              })
            }
          />
        </Fields>
        <span style={hint}>{t('workflow.setWindowNote')}</span>
      </Group>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderTop: '1px solid var(--line)',
          paddingTop: 20,
        }}
      >
        <div style={caps}>{t('workflow.setAlertsTitle')}</div>
        <Fields>
          <NumberField
            name="workflowAlertRework"
            label={t('workflow.setAlertRework')}
            value={shareToField(workflow.alerts.rework)}
            unit="%"
            epoch={epoch}
            nullable
            onCommit={(value) =>
              onChange({
                workflow: { alerts: { rework: value === null ? null : fieldToShare(value) } },
              })
            }
          />
          <NumberField
            name="workflowAlertErrors"
            label={t('workflow.setAlertErrors')}
            value={shareToField(workflow.alerts.errorRate)}
            unit="%"
            epoch={epoch}
            nullable
            onCommit={(value) =>
              onChange({
                workflow: { alerts: { errorRate: value === null ? null : fieldToShare(value) } },
              })
            }
          />
          <NumberField
            name="workflowAlertOverhead"
            label={t('workflow.setAlertOverhead')}
            value={multipleToField(workflow.alerts.overhead)}
            prefix="×"
            epoch={epoch}
            nullable
            onCommit={(value) => onChange({ workflow: { alerts: { overhead: value } } })}
          />
        </Fields>
        <span style={hint}>{t('workflow.setAlertsNote')}</span>
      </div>
    </div>
  )
}

// ─── кирпичики ────────────────────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={caps}>{title}</div>
      {children}
    </div>
  )
}

function Fields({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      {children}
    </div>
  )
}

/**
 * Поле без своей рамки: рамку рисует то, в чём оно стоит. Ноль в `padding` — сброс
 * браузерного отступа у `input`, а не значение из макета (`OFF_SPEC`).
 */
function bare({ mono = false }: { mono?: boolean } = {}): CSSProperties {
  return {
    border: 0,
    padding: 0,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    ...(mono ? { fontFamily: MONO } : {}),
    minWidth: 0,
    width: '100%',
    outline: 'none',
  }
}

const roleStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 8px',
  borderRadius: 4,
  border: 0,
  background: 'var(--s2)',
  color: 'var(--tx)',
  font: 'inherit',
}

interface FieldProps {
  name: string
  label: string
  value: string
  /** Часть ключа: сменилась — поле перерисовывается и показывает конфиг, а не набранное. */
  epoch: string
}

/**
 * Текстовое поле: правка уходит по уходу фокуса или Enter, Esc отменяет набранное.
 * Неуправляемое, так что и тесту, и браузеру достаточно обработчиков — состояния нет.
 */
function TextField({
  name,
  label,
  value,
  epoch,
  mono = false,
  box = false,
  onCommit,
}: FieldProps & { mono?: boolean; box?: boolean; onCommit: (text: string) => void }) {
  return (
    <input
      key={`${name}\u0000${value}\u0000${epoch}`}
      data-setting={name}
      aria-label={label}
      defaultValue={value}
      spellCheck={false}
      autoComplete="off"
      maxLength={PATTERN_MAX}
      onBlur={(event) => {
        const next = event.currentTarget.value
        if (next === value) return
        onCommit(next)
        // Поле показывает конфиг, а не набранное: принятая правка сменит `value`, и
        // поле перерисуется новым ключом, а отвергнутая (или не отправленная, как
        // пустой шаблон) не оставит ввод под видом принятого — даже когда замечание
        // сервера дословно то же, что в прошлый раз, и `epoch` не сменился.
        event.currentTarget.value = value
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.value = value
        if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
      }}
      style={
        box
          ? {
              ...bare({ mono }),
              fontSize: 11.5,
              padding: '8px 12px',
              background: 'var(--s1)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              boxSizing: 'border-box',
            }
          : { ...bare({ mono }), fontSize: 11.5 }
      }
    />
  )
}

/**
 * Числовое поле. `onCommit` получает число или `null` (пусто, только у `nullable`);
 * то, что числом не прочитать, не уходит вовсе, а набранное откатывается.
 */
function NumberField({
  name,
  label,
  value,
  epoch,
  prefix,
  unit,
  filled = false,
  nullable = false,
  onCommit,
}: FieldProps & {
  prefix?: string
  unit?: string
  filled?: boolean
  nullable?: boolean
  onCommit: (value: number | null) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--tx2)' }}>{label}</span>
      <label
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 4,
          fontFamily: MONO,
          fontSize: 12,
          padding: '8px 12px',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontVariantNumeric: 'tabular-nums',
          ...(filled ? { background: 'var(--s1)' } : {}),
        }}
      >
        {prefix === undefined ? null : <span style={{ color: 'var(--tx3)' }}>{prefix}</span>}
        <input
          key={`${name}\u0000${value}\u0000${epoch}`}
          data-setting={name}
          aria-label={label}
          defaultValue={value}
          placeholder="—"
          inputMode="decimal"
          autoComplete="off"
          onBlur={(event) => {
            const text = event.currentTarget.value
            if (text === value) return
            const parsed = parseField(text)
            // Не число — откат на показанное; пусто там, где пустого не бывает, — тоже.
            if (parsed === undefined || (parsed === null && !nullable)) {
              event.currentTarget.value = value
              return
            }
            onCommit(parsed)
            // Как у текстового поля: принятое придёт новым `value`, отвергнутое не останется.
            event.currentTarget.value = value
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.value = value
            if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
          }}
          style={bare({ mono: true })}
        />
        {unit === undefined ? null : <span style={{ color: 'var(--tx3)' }}>{unit}</span>}
      </label>
    </div>
  )
}

function RoleSelect({
  name,
  label,
  value,
  onChange,
}: {
  name: string
  label: string
  value: AssignableRole
  onChange: (role: AssignableRole) => void
}) {
  return (
    <select
      data-setting={name}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value as AssignableRole)}
      style={roleStyle}
    >
      {ASSIGNABLE.map((role) => (
        <option key={role} value={role}>
          {roleName(role)}
        </option>
      ))}
    </select>
  )
}

function Action({
  name,
  label,
  glyph,
  disabled = false,
  onClick,
}: {
  name: string
  label: string
  glyph: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-workflow-rule-action={name}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'var(--tx3)',
        fontFamily: MONO,
        fontSize: 11,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {glyph}
    </button>
  )
}
