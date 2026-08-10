import { formatTokens, plural } from '../format.ts'

export interface FoldedTailProps {
  count: number
  belowTokens: number
}

export function FoldedTail({ count, belowTokens }: FoldedTailProps) {
  return (
    <div
      style={{
        padding: '10px 12px',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        color: 'var(--tx3)',
      }}
    >
      и ещё {plural(count, ['задача', 'задачи', 'задач'])} ниже {formatTokens(belowTokens)} —
      свернуто
    </div>
  )
}
