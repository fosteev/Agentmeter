import type { WorkflowRoleKey, WorkflowRolesBlock } from '@agentmeter/ipc'
import { formatPercent, formatTokens, t } from '../format.ts'
import { MONO, roleName } from '../workflow.ts'

/**
 * Роли и «кто правил после исполнителя» — строки 2754–2839 макета (раздел 13).
 *
 * Шесть строк ролей — всегда, `unknown` тоже: строка, а не главный блок (в циклах
 * его мало), но пропавшая строка читалась бы как «таких субагентов нет». Доли
 * расхода и «после» приехали посчитанными (правило 13); окно решает одно —
 * длину полоски относительно наибольшей роли.
 *
 * Расход учтён по всем циклам окна, записи и «после» — только по циклам, где
 * исполнитель виден. Поэтому сумма «после» равна числителю главного числа, и
 * разбивка справа объясняет его, а не соседнее.
 */
export interface WorkflowRolesProps {
  roles: WorkflowRolesBlock
}

const COLUMNS = '168px 1fr 120px 64px 112px'

const caps = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--tx3)',
} as const

const head = {
  display: 'grid',
  gridTemplateColumns: COLUMNS,
  gap: 12,
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--tx3)',
  paddingBottom: 4,
  borderBottom: '1px solid var(--line)',
} as const

/** Тихие роли: подпись приглушена, как у разведки и «роли не определена» в макете. */
const QUIET: readonly WorkflowRoleKey[] = ['explore', 'unknown']

/** Светлота сегмента «после исполнителя»: главная тусклее, ревьюер ярче, остальные между. */
const AFTER_COLOR: Record<WorkflowRoleKey, string> = {
  main: 'var(--tx2)',
  executor: 'var(--tx2)',
  reviewer: 'var(--tx)',
  planner: 'color-mix(in oklch, var(--tx) 52%, transparent)',
  explore: 'color-mix(in oklch, var(--tx) 30%, transparent)',
  unknown: 'var(--tx3)',
}

export function WorkflowRoles({ roles }: WorkflowRolesProps) {
  const widest = Math.max(...roles.rows.map((row) => row.spend), 0)

  return (
    <div
      data-workflow-roles
      style={{
        padding: '20px 32px',
        display: 'grid',
        gridTemplateColumns: '1fr 320px',
        gap: 32,
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={caps}>{t('workflow.rolesTitle', { count: roles.cycles })}</span>
          {roles.unseen === 0 ? null : (
            <span
              data-workflow-roles-unseen
              style={{ fontFamily: MONO, fontSize: 11, color: 'var(--tx2)' }}
            >
              {t('workflow.rolesUnseen', { count: roles.unseen })}
            </span>
          )}
        </div>

        <div style={head}>
          <span>{t('workflow.rolesHeadRole')}</span>
          <span>{t('workflow.rolesHeadSpend')}</span>
          <span />
          <span style={{ textAlign: 'right' }}>{t('workflow.rolesHeadEdits')}</span>
          <span style={{ textAlign: 'right' }}>{t('workflow.rolesHeadAfter')}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {roles.rows.map((row) => {
            const empty = row.spend === 0
            return (
              <div
                key={row.role}
                data-workflow-role={row.role}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COLUMNS,
                  gap: 12,
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontSize: 12.5,
                    ...(QUIET.includes(row.role) ? { color: 'var(--tx2)' } : {}),
                  }}
                >
                  {roleName(row.role)}
                </span>
                <div
                  style={{
                    height: 12,
                    borderRadius: 2,
                    background: 'var(--s2)',
                    overflow: 'hidden',
                  }}
                >
                  {empty ? null : (
                    <div
                      style={{
                        width: `${widest === 0 ? 0 : (row.spend / widest) * 100}%`,
                        height: '100%',
                        background: row.role === 'unknown' ? 'var(--tx3)' : 'var(--tx2)',
                      }}
                    />
                  )}
                </div>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 12,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    ...(empty ? { color: 'var(--tx3)' } : { fontWeight: 600 }),
                  }}
                >
                  {formatTokens(row.spend)} · {formatPercent(row.share, 1)}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 12,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: row.writes === 0 ? 'var(--tx3)' : 'var(--tx2)',
                  }}
                >
                  {row.writes}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 12,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    ...(row.after === null || row.after === 0 ? { color: 'var(--tx3)' } : {}),
                  }}
                >
                  {row.after === null ? '—' : row.after}
                </span>
              </div>
            )
          })}
        </div>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--tx3)' }}>
          {t('workflow.rolesLegend')}
        </span>
      </div>

      <After roles={roles} />
    </div>
  )
}

function After({ roles }: WorkflowRolesProps) {
  const { after } = roles
  return (
    <div data-workflow-after style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={caps}>{t('workflow.afterTitle')}</span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 13,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {after.total}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 2,
          height: 20,
          borderRadius: 4,
          overflow: 'hidden',
          background: after.total === 0 ? 'var(--s2)' : undefined,
        }}
      >
        {after.rows
          .filter((row) => row.count > 0)
          .map((row) => (
            <div
              key={row.role}
              data-workflow-after-segment={row.role}
              style={{ width: `${row.share * 100}%`, background: AFTER_COLOR[row.role] }}
            />
          ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {after.rows.map((row) => (
          <div
            key={row.role}
            data-workflow-after-row={row.role}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 12,
              alignItems: 'baseline',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{ width: 8, height: 8, borderRadius: 2, background: AFTER_COLOR[row.role] }}
              />
              <span style={{ fontSize: 12.5 }}>{roleName(row.role)}</span>
              {row.role === 'main' || row.role === 'reviewer' ? (
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--tx3)' }}>
                  {row.role === 'main' ? t('workflow.afterMainHint') : t('workflow.afterAgentHint')}
                </span>
              ) : null}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {row.count} · {formatPercent(row.share, 1)}
            </span>
          </div>
        ))}
        {after.quiet.length === 0 ? null : (
          <div
            data-workflow-after-quiet
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 12,
              alignItems: 'baseline',
              opacity: 0.55,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{ width: 8, height: 8, borderRadius: 2, boxShadow: 'inset 0 0 0 1px var(--tx3)' }}
              />
              <span style={{ fontSize: 12.5 }}>{quietLabel(after.quiet)}</span>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              0
            </span>
          </div>
        )}
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
        {t('workflow.afterNote')}
      </span>
    </div>
  )
}

/** «Планировщик, разведка, роль не определена»: первое слово с большой буквы, остальные со строчной. */
export function quietLabel(roles: readonly WorkflowRoleKey[]): string {
  return roles
    .map((role, index) => {
      const name = roleName(role)
      return index === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1)
    })
    .join(', ')
}
