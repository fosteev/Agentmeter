import type { ProjectRow, TicketRow } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { hatch } from '../paint.ts'

/**
 * Полосы «По проектам» и «По тикетам» — один компонент на два списка (3.7).
 *
 * Вид у них общий (строки 795–800 макета), и вторая копия разошлась бы с первой
 * на первой же правке ширины полосы. Различаются они ровно подписью
 * свёрнутого хвоста: «+ 4 проекта» против «+ 4 тикетов», и это данные, а не
 * повод для второго компонента.
 */
export interface ProjectBarsProps {
  projects: Array<ProjectRow | TicketRow>
  /** Что за список. От него зависит только подпись хвоста. */
  kind?: 'project' | 'ticket'
}

function name(row: ProjectRow | TicketRow): string {
  return 'project' in row ? row.project : row.ticket
}

export function ProjectBars({ projects, kind = 'project' }: ProjectBarsProps) {
  const maximum = Math.max(0, ...projects.map((row) => row.tokens.value))

  return (
    <div data-bars={kind} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {projects.map((row, index) => {
        const folded = row.folded !== undefined
        const approximate = row.tokens.confidence !== 'exact'
        const color = row.provider === null ? 'var(--tx3)' : `var(--${row.provider})`
        const width = maximum === 0 ? 0 : (row.tokens.value / maximum) * 100

        return (
          <div
            key={folded ? `folded-${row.folded}` : `${name(row)}-${index}`}
            data-project-row={index}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 62px',
              gap: 8,
              alignItems: 'center',
            }}
            title={row.tokens.caveat}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: folded ? 'var(--tx2)' : undefined }}>
                {folded
                  ? t(kind === 'ticket' ? 'today.tickets' : 'today.projects', {
                      count: row.folded!,
                    })
                  : name(row)}
              </span>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  background: 'var(--s2)',
                  overflow: 'hidden',
                }}
              >
                <div
                  data-project-fill={index}
                  style={{
                    width: `${width}%`,
                    height: '100%',
                    background: approximate ? hatch(color) : color,
                  }}
                />
              </div>
            </div>
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 11.5,
                textAlign: 'right',
                color: folded ? 'var(--tx2)' : undefined,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {approximate ? '≈' : ''}
              {formatTokens(row.tokens.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
