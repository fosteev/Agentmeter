import type { ProjectRow } from '@agentmeter/ipc'
import { formatTokens, plural } from '../format.ts'
import { hatch } from '../paint.ts'

export interface ProjectBarsProps {
  projects: ProjectRow[]
}

export function ProjectBars({ projects }: ProjectBarsProps) {
  const maximum = Math.max(0, ...projects.map((row) => row.tokens.value))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {projects.map((row, index) => {
        const folded = row.folded !== undefined
        const approximate = row.tokens.confidence !== 'exact'
        const color = row.provider === null ? 'var(--tx3)' : `var(--${row.provider})`
        const width = maximum === 0 ? 0 : (row.tokens.value / maximum) * 100

        return (
          <div
            key={folded ? `folded-${row.folded}` : `${row.project}-${index}`}
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
                  ? `+ ${plural(row.folded!, ['проект', 'проекта', 'проектов'])}`
                  : row.project}
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
