import type { ReactNode } from 'react'
import type { WorkflowReworkBlock, WorkflowScreen } from '@agentmeter/ipc'
import {
  dateLong,
  dateRange,
  formatPercent,
  formatSigned,
  t,
} from '../format.ts'
import { MONO } from '../workflow.ts'
import { WorkflowChart } from './WorkflowChart.tsx'
import { WorkflowControls } from './WorkflowControls.tsx'
import { WorkflowRoles } from './WorkflowRoles.tsx'

/**
 * Вкладка «Workflow» — раздел 13 макета, строки 2594–2627 и 2842–2951 (9.5).
 *
 * Экран отвечает на один вопрос: какую часть кода цикла дописали после
 * исполнителя, и меняется ли эта доля от цикла к циклу. Порядок чтения взят у
 * дашборда discovery: главное число, график по циклам, три контрольных, роли,
 * поправки. Оценок экран не ставит — цвет у дельты есть только при заданной цели
 * и значит «к цели», а не «хорошо».
 *
 * Пустых состояний пять, и слова у них разные (правило 15): «индекс не собран»,
 * «ни одного исполнителя по вашим правилам», «фильтр отсёк всё», «окно не
 * набралось» и — вне вкладки — «Workflow выключен» (его место над выключателем в
 * настройках). Схлопни любые два, и одно из них соврёт.
 *
 * Фильтр проекта сужает окно, а не только картинку: ответ приходит уже
 * пересчитанным, и `count` в нём — число циклов этого проекта.
 */
export interface WorkflowTabProps {
  /** `null` — ответ ещё не пришёл. */
  screen: WorkflowScreen | null
  onProjectChange: (project: string | undefined) => void
  /** Перейти в настройки Workflow (ссылки в пустых состояниях). */
  onOpenSettings: () => void
}

/** Столько проектов умещается сегментами; больше — выпадающий список. */
const SEGMENTS_MAX = 5

const caps = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--tx3)',
} as const

export function WorkflowTab({ screen, onProjectChange, onOpenSettings }: WorkflowTabProps) {
  return (
    <div
      data-workflow
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'auto',
      }}
    >
      {screen === null ? (
        <div
          data-workflow-loading
          style={{ padding: '20px 32px', color: 'var(--tx2)', fontSize: 12.5 }}
        >
          {t('workflow.loading')}
        </div>
      ) : (
        <Body screen={screen} onProjectChange={onProjectChange} onOpenSettings={onOpenSettings} />
      )}
    </div>
  )
}

function Body({
  screen,
  onProjectChange,
  onOpenSettings,
}: {
  screen: WorkflowScreen
} & Omit<WorkflowTabProps, 'screen'>) {
  const { rework } = screen
  return (
    <>
      <Header screen={screen} onProjectChange={onProjectChange} />
      {screen.state === 'ready' ? (
        <>
          <div
            style={{
              padding: '20px 32px',
              display: 'grid',
              gridTemplateColumns: rework.short ? '1fr' : '320px 1fr',
              gap: 32,
              borderBottom: '1px solid var(--line)',
            }}
          >
            {rework.short ? (
              <Empty
                name="short"
                title={t('workflow.emptyShortTitle', { count: rework.count, size: rework.size })}
                text={t('workflow.emptyShortText', { count: rework.size - rework.count })}
                link={t('workflow.emptyShortLink')}
                onLink={onOpenSettings}
              >
                <Ticks have={rework.count} size={rework.size} />
              </Empty>
            ) : (
              <>
                <Headline rework={rework} />
                <WorkflowChart rework={rework} cycles={screen.cycles} />
              </>
            )}
          </div>
          <WorkflowControls
            overhead={screen.overhead}
            errors={screen.errors}
            verdicts={screen.verdicts}
          />
          <WorkflowRoles roles={screen.roles} />
          <Footer />
        </>
      ) : (
        <div style={{ padding: '20px 32px', display: 'flex' }}>
          <Empty {...emptyOf(screen, onProjectChange, onOpenSettings)} />
        </div>
      )}
    </>
  )
}

// ─── шапка и фильтр ───────────────────────────────────────────────────────────

function Header({
  screen,
  onProjectChange,
}: {
  screen: WorkflowScreen
  onProjectChange: (project: string | undefined) => void
}) {
  return (
    <div
      data-workflow-header
      style={{
        padding: '20px 32px',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 32,
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{t('workflow.title')}</div>
        <div style={{ fontSize: 12.5, color: 'var(--tx2)', maxWidth: 640, lineHeight: 1.5 }}>
          {t('workflow.lead')}
        </div>
        {screen.period === null ? null : (
          <span
            data-workflow-period
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: 'var(--tx3)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {t('workflow.period', {
              cycles: t('workflow.cyclesCount', { count: screen.cycles.length }),
              range: dateRange(screen.period.from, screen.period.to),
              window: t('workflow.cyclesCount', { count: screen.window.cycles }),
            })}
          </span>
        )}
      </div>
      <ProjectFilter screen={screen} onChange={onProjectChange} />
    </div>
  )
}

function ProjectFilter({
  screen,
  onChange,
}: {
  screen: WorkflowScreen
  onChange: (project: string | undefined) => void
}) {
  const { projects, project } = screen
  // Один проект (или ни одного) выбирать не из чего.
  if (projects.length < 2 && project === undefined) return null

  if (projects.length > SEGMENTS_MAX) {
    return (
      <select
        data-workflow-filter="select"
        aria-label={t('workflow.allProjects')}
        value={project ?? ''}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
        style={{
          padding: '4px 12px',
          border: 0,
          borderRadius: 6,
          background: 'var(--s1)',
          color: 'var(--tx)',
          font: 'inherit',
          fontSize: 11.5,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <option value="">{t('workflow.allProjects')}</option>
        {/* Выбранный проект, пропавший из списка (циклы ушли), остаётся пунктом: иначе
            список стоит на «все проекты», и выбрать их, чтобы сбросить фильтр, нельзя. */}
        {project !== undefined && !projects.some((item) => item.name === project) ? (
          <option value={project}>{project}</option>
        ) : null}
        {projects.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name}
          </option>
        ))}
      </select>
    )
  }

  const choices: Array<{ value: string | undefined; label: string }> = [
    { value: undefined, label: t('workflow.allProjects') },
    ...projects.map((item) => ({ value: item.name, label: item.name })),
  ]
  return (
    <div
      data-workflow-filter="segments"
      style={{
        display: 'flex',
        gap: 2,
        padding: 2,
        background: 'var(--s1)',
        borderRadius: 6,
        flexShrink: 0,
      }}
    >
      {choices.map(({ value, label }) => {
        const selected = project === value
        return (
          <button
            key={label}
            type="button"
            data-workflow-project={value ?? ''}
            aria-pressed={selected}
            onClick={() => onChange(value)}
            style={{
              padding: '4px 12px',
              border: 0,
              borderRadius: 4,
              background: selected ? 'var(--s2)' : 'transparent',
              color: selected ? 'var(--tx)' : 'var(--tx2)',
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

// ─── главное число ────────────────────────────────────────────────────────────

/**
 * «Переделка · по видимым правкам»: число, дельта, окно, цель и — если в окне
 * есть циклы, где исполнитель правил шеллом — строка об этом. Подпись числа
 * называет, что именно оно считает: видимые правки, а не вся переделка.
 */
function Headline({ rework }: { rework: WorkflowReworkBlock }) {
  const { latest, prev, delta, target } = rework
  const at = latest?.startedAt ?? rework.lastStartedAt
  const notes: string[] = []
  if (prev !== null) notes.push(t('workflow.prevWindow', { value: formatPercent(prev.value, 1) }))
  if (target !== null) notes.push(t('workflow.targetLabel', { pct: formatPercent(target, 0) }))

  return (
    <div data-workflow-headline style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={caps}>{t('workflow.mainLabel')}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span
          data-workflow-value
          style={{
            fontFamily: MONO,
            fontSize: 24,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            ...(latest === null ? { color: 'var(--tx3)' } : {}),
          }}
        >
          {latest === null ? '—' : formatPercent(latest.value, 1)}
        </span>
        {delta !== null ? (
          <span
            data-workflow-delta={delta.tone}
            style={{
              fontFamily: MONO,
              fontSize: 13,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              // Цвет — направление к цели, а не оценка (9.4).
              color: delta.tone === 'toward' ? 'var(--ok)' : 'var(--tx2)',
            }}
          >
            {delta.approximate ? '≈' : ''}
            {t('workflow.deltaPoints', { value: formatSigned(delta.value, 1) })}
          </span>
        ) : latest !== null ? (
          <span
            data-workflow-delta="none"
            style={{ fontFamily: MONO, fontSize: 11, color: 'var(--tx3)' }}
          >
            {t('workflow.deltaNone')}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {at === null ? null : (
          <span style={{ fontSize: 12, color: 'var(--tx2)' }}>
            {t('workflow.windowLast', { count: rework.size, date: dateLong(at) })}
          </span>
        )}
        {notes.length === 0 ? null : (
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: 'var(--tx3)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {notes.join(' · ')}
          </span>
        )}
      </div>
      {latest !== null && delta === null && rework.noDelta !== null ? (
        <span
          data-workflow-nodelta={rework.noDelta}
          style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}
        >
          {rework.noDelta === 'short'
            ? t('workflow.noDeltaShort', { count: rework.need, have: rework.count })
            : t('workflow.noDeltaNoPoint')}
        </span>
      ) : null}
      {rework.unseen === 0 ? null : (
        <div
          data-workflow-unseen
          style={{
            display: 'flex',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 6,
            background: 'var(--s1)',
            border: '1px solid var(--line)',
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--tx3)', flexShrink: 0 }}>
            ›_
          </span>
          <span style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
            {unseenLine(rework)}
          </span>
        </div>
      )}
      {latest === null ? (
        <span
          data-workflow-nopoint
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: 'var(--tx3)',
            borderTop: '1px solid var(--line)',
            paddingTop: 12,
          }}
        >
          {t('workflow.noPointAll', { n: rework.count })}
        </span>
      ) : (
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: 'var(--tx3)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {t('workflow.visibleOf', {
            num: latest.numerator,
            den: latest.denominator,
          })}
        </span>
      )}
    </div>
  )
}

/** «по 2 из 3 циклов: в 1 цикле исполнитель правил шеллом…» — или «в 3 циклах из 3…», если исключены все. */
export function unseenLine(rework: WorkflowReworkBlock): string {
  const { unseen, size } = rework
  if (unseen >= size) return t('workflow.unseenAll', { count: unseen, size })
  return t('workflow.unseenSome', { count: unseen, visible: size - unseen, size })
}

// ─── пустые состояния ─────────────────────────────────────────────────────────

interface EmptyProps {
  name: string
  title: string
  text: string
  link?: string
  onLink?: () => void
  children?: ReactNode
}

function Empty({ name, title, text, link, onLink, children }: EmptyProps) {
  return (
    <div
      data-workflow-empty={name}
      style={{
        flex: 1,
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 13 }}>{title}</div>
      {children}
      <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>{text}</div>
      {link === undefined ? null : (
        <a
          href="#"
          data-workflow-link={name}
          onClick={(event) => {
            event.preventDefault()
            onLink?.()
          }}
          style={{
            alignSelf: 'flex-start',
            color: 'var(--codex)',
            textDecoration: 'none',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {link}
        </a>
      )}
    </div>
  )
}

/** Десять делений окна: сколько циклов уже набралось из нужных. */
function Ticks({ have, size }: { have: number; size: number }) {
  return (
    <div
      data-workflow-ticks
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${size}, 1fr)`,
        gap: 4,
      }}
    >
      {Array.from({ length: size }, (_, index) => (
        <div
          key={index}
          style={{
            height: 6,
            borderRadius: 2,
            ...(index < have
              ? { background: 'var(--tx2)' }
              : { boxShadow: 'inset 0 0 0 1px var(--line)' }),
          }}
        />
      ))}
    </div>
  )
}

/** Какое из трёх нерисованных состояний — по ответу, а не по догадке окна. */
function emptyOf(
  screen: WorkflowScreen,
  onProjectChange: (project: string | undefined) => void,
  onOpenSettings: () => void,
): EmptyProps {
  if (screen.state === 'indexing') {
    return {
      name: 'indexing',
      title: t('workflow.emptyIndexTitle'),
      text: t('workflow.emptyIndexText'),
    }
  }
  if (screen.state === 'scope') {
    return {
      name: 'scope',
      title: t('workflow.emptyScopeTitle', { project: screen.project ?? '' }),
      text: t('workflow.emptyScopeText'),
      link: t('workflow.emptyScopeLink'),
      onLink: () => onProjectChange(undefined),
    }
  }
  return {
    name: 'none',
    title: t('workflow.emptyNoneTitle'),
    text: t('workflow.emptyNoneText'),
    link: t('workflow.emptyNoneLink'),
    onLink: onOpenSettings,
  }
}

// ─── подвал ───────────────────────────────────────────────────────────────────

/**
 * Измеренные поправки словами (9.4): шелл и MCP не видны, и на живых циклах
 * шеллом идёт большинство правок у всех ролей; накладные — токены, а не деньги.
 * Грубый счёт пробы («32 из 208») в продукт не едет: шелл не разбирается, а
 * угаданное нечем честно пометить.
 */
function Footer() {
  const paragraph = { fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.55 } as const
  return (
    <div
      data-workflow-footer
      style={{
        padding: '12px 32px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--s1)',
      }}
    >
      <div style={paragraph}>
        <span style={{ color: 'var(--tx)' }}>{t('workflow.footerVisibleLead')}</span>{' '}
        {t('workflow.footerVisibleBody')}
      </div>
      <div style={paragraph}>
        <span style={{ color: 'var(--tx)' }}>{t('workflow.footerTokensLead')}</span>{' '}
        {t('workflow.footerTokensBody')}
      </div>
    </div>
  )
}
