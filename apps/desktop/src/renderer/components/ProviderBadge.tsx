import type { Provider } from '@agentmeter/core'

// Бейдж провайдера — строка 360 макета: «CL» на янтарном, «CX» на холодном,
// текст цветом фона. Двухбуквенный намеренно: в попапе 400px шириной полное имя
// съедает место у имени проекта, а различить провайдера надо с одного взгляда —
// это единственная метка, по которой строка читается как «Claude» или «Codex»
// без чтения текста.
//
// Контекстов было два, остался один: из строки лимита бейдж ушёл, там провайдера
// называет таб (416–429, этап 7.1). Вместе с ним ушёл и отступ справа — он был
// нужен только там, а в строке агента бейдж отбит зазором сетки.

export interface ProviderBadgeProps {
  provider: Provider
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

const SHORT: Record<Provider, string> = {
  claude: 'CL',
  codex: 'CX',
}

export function ProviderBadge({ provider }: ProviderBadgeProps) {
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
        flex: 'none',
      }}
    >
      {SHORT[provider]}
    </span>
  )
}
