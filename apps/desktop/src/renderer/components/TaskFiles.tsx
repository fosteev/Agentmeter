import type { TaskCard as TaskCardData } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { SectionTitle } from './SectionTitle.tsx'

export function TaskFiles({ files }: { files?: TaskCardData['files'] }) {
  if (files === undefined) return null
  const hidden = Math.max(0, files.total - files.paths.length)

  return (
    <div
      data-task-files=""
      style={{
        borderTop: '1px solid var(--line)',
        paddingTop: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <SectionTitle title={t('card.files', { count: files.total })} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10.5,
          color: 'var(--tx2)',
        }}
      >
        {files.paths.map((path) => (
          <span
            key={path}
            data-file-chip="path"
            style={{ padding: '3px 7px', border: '1px solid var(--line)', borderRadius: 4 }}
          >
            {path}
          </span>
        ))}
        {hidden === 0 ? null : (
          <span
            data-file-chip="tail"
            style={{
              padding: '3px 7px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              color: 'var(--tx3)',
            }}
          >
            + {hidden}
          </span>
        )}
      </div>
    </div>
  )
}
