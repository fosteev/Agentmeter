import type { Provider } from '@agentmeter/core'

// Бейдж провайдера — строки 355 и 415 макета: «CL» на янтарном, «CX» на
// холодном, текст цветом фона. Двухбуквенный намеренно: в попапе 400px шириной
// полное имя съедает место у имени проекта, а различить провайдера надо с
// одного взгляда — это единственная метка, по которой строка читается как
// «Claude» или «Codex» без чтения текста.

export interface ProviderBadgeProps {
  provider: Provider
  /** Отступ справа: 6 в шапке лимита (строка 415), в строке агента его нет. */
  marginRight?: number
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

const SHORT: Record<Provider, string> = {
  claude: 'CL',
  codex: 'CX',
}

export function ProviderBadge({ provider, marginRight }: ProviderBadgeProps) {
  return (
    <span
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 9,
        fontWeight: 600,
        color: 'var(--bg)',
        background: ACCENT[provider],
        borderRadius: 3,
        padding: '1px 4px',
        marginRight,
        flex: 'none',
      }}
    >
      {SHORT[provider]}
    </span>
  )
}
