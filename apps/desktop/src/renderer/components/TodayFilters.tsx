import type { Provider } from '@agentmeter/core'
import type { TodayFilter } from '@agentmeter/ipc'

export interface TodayFiltersProps {
  filter: TodayFilter
  onChange: (filter: TodayFilter) => void
}

const PROVIDERS: ReadonlyArray<{ value: Provider | undefined; label: string }> = [
  { value: undefined, label: 'все' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
]

function withProvider(filter: TodayFilter, provider: Provider | undefined): TodayFilter {
  const next = { ...filter }
  if (provider === undefined) delete next.provider
  else next.provider = provider
  return next
}

export function TodayFilters({ filter, onChange }: TodayFiltersProps) {
  return (
    <div style={{ padding: '0 24px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--s1)', borderRadius: 6 }}
      >
        {PROVIDERS.map(({ value, label }) => {
          const selected = filter.provider === value
          return (
            <button
              key={label}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(withProvider(filter, value))}
              style={{
                padding: '4px 10px',
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
      <div style={{ flex: 1 }} />
      <label
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          color: 'var(--tx3)',
          whiteSpace: 'nowrap',
        }}
      >
        сортировка:{' '}
        <select
          aria-label="Сортировка"
          value={filter.sort ?? 'tokens'}
          onChange={(event) =>
            onChange({
              ...filter,
              sort: event.currentTarget.value as NonNullable<TodayFilter['sort']>,
            })
          }
          style={{
            border: 0,
            background: 'transparent',
            color: 'var(--tx3)',
            font: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          <option value="tokens">по расходу ↓</option>
          <option value="started">по времени ↓</option>
          <option value="requests">по запросам ↓</option>
        </select>
      </label>
    </div>
  )
}
