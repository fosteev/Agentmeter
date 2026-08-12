import type { LimitReportRow, Provider } from '@agentmeter/core'
import { limitLevel } from './PopupLimit.tsx'

// Табы провайдеров над списком лимитов — строки 416–429 макета: ряд подписей на
// отчёркнутой линии, у каждой квадратная точка цвета провайдера, у выбранной
// подчёркивание его же цветом.
//
// Табы ничего не считают: и список, и стартовый выбор выводятся из тех же окон,
// что рисуются ниже (`limits` снимка). Второго счёта расхода здесь нет — есть
// группировка уже посчитанного.
//
// Два правила этапа — не украшение, а условие, ради которого он делался. Попап
// отвечает на один вопрос, «можно ли работать дальше», и таб, за которым остался
// Codex на 94%, отвечает на него молчаливым «да»:
//
// 1. **У неактивного таба точка горит уровнем его худшего окна** (>85 —
//    `--alarm`, 60–85 — `--warn`). У выбранного она остаётся цвета провайдера,
//    как в макете: его проценты видны числами прямо под ней, и красить точку
//    вторым способом сказать то же самое незачем.
// 2. **Попап открывается на самом тревожном провайдере** — по уровню, а не по
//    проценту. Ниже 60% разница между 5% и 31% ничего не решает, а вот
//    провайдер, у которого процента нет вовсе (у Claude до 1.9 его нет ни у
//    одного окна), проиграл бы чужим пяти процентам и уехал за клик. Поэтому
//    там, где тревожиться не о чем, выбор падает на постоянный порядок.

/** Провайдер с действующими окнами и худшее из них. */
export interface LimitTab {
  provider: Provider
  label: string
  /** Наибольший известный процент среди окон провайдера. `null` — неизвестны все. */
  worst: number | null
}

/**
 * Порядок задан, а не унаследован от данных, — как в шапке главного окна: иначе
 * табы меняются местами от снимка к снимку, и глаз каждый раз ищет свой заново.
 */
const ORDER: readonly Provider[] = ['claude', 'codex']

/** Имена продуктов не переводятся — как в фильтре ленты и на экране ошибки. */
const LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

const ACCENT: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
}

/**
 * Табы по окнам снимка.
 *
 * Таб появляется только у провайдера, чьи окна в снимке есть: выключенный
 * источник не читается вовсе, а таб, ведущий на пустоту, обещает данные,
 * которых нет. Kimi и Ollama из макета сюда не попадают по той же причине —
 * `Provider` в ядре это `'claude' | 'codex'`, парсеров для них нет.
 */
export function limitTabs(limits: readonly LimitReportRow[]): LimitTab[] {
  const worst = new Map<Provider, number | null>()
  for (const window of limits) {
    const current = worst.get(window.provider) ?? null
    const next =
      window.usedPercent === null
        ? current
        : current === null
          ? window.usedPercent
          : Math.max(current, window.usedPercent)
    worst.set(window.provider, next)
  }
  return ORDER.filter((provider) => worst.has(provider)).map((provider) => ({
    provider,
    label: LABEL[provider],
    worst: worst.get(provider) ?? null,
  }))
}

function rank(worst: number | null): number {
  const level = limitLevel(worst)
  return level === 'alarm' ? 2 : level === 'warn' ? 1 : 0
}

/**
 * На каком табе открыть попап.
 *
 * Сначала уровень тревоги, внутри уровня — процент, а при равенстве уровней
 * ниже тревожного решает порядок, а не процент: 31% против 5% не повод прятать
 * провайдера, чей процент нам пока неизвестен вовсе.
 *
 * Памяти о прошлом выборе здесь нет и не будет: запомненный таб — это тот же
 * спрятанный Codex, только с задержкой в один запуск.
 */
export function alarmingProvider(tabs: readonly LimitTab[]): Provider | undefined {
  let best: LimitTab | undefined
  for (const tab of tabs) {
    if (best === undefined) {
      best = tab
      continue
    }
    const mine = rank(tab.worst)
    const theirs = rank(best.worst)
    if (mine > theirs || (mine === theirs && mine > 0 && (tab.worst ?? 0) > (best.worst ?? 0))) {
      best = tab
    }
  }
  return best?.provider
}

export interface PopupLimitTabsProps {
  tabs: readonly LimitTab[]
  active: Provider | undefined
  onSelect?: ((provider: Provider) => void) | undefined
}

export function PopupLimitTabs({ tabs, active, onSelect }: PopupLimitTabsProps) {
  return (
    <div
      data-limit-tabs=""
      style={{
        padding: '8px 14px 0',
        display: 'flex',
        gap: 2,
        borderBottom: '1px solid var(--line)',
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.provider === active
        // Уровень поднимает точку только у неактивного таба: у выбранного те же
        // проценты стоят числами строкой ниже.
        const level = selected ? null : limitLevel(tab.worst)
        return (
          <button
            key={tab.provider}
            type="button"
            data-limit-tab={tab.provider}
            aria-pressed={selected}
            onClick={() => onSelect?.(tab.provider)}
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10.5,
              letterSpacing: '.04em',
              padding: '5px 8px 6px',
              background: 'transparent',
              color: selected ? 'var(--tx)' : 'var(--tx3)',
              border: 0,
              borderBottom: `2px solid ${selected ? ACCENT[tab.provider] : 'transparent'}`,
              marginBottom: -1,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
            }}
          >
            <span
              data-limit-tab-dot={level ?? 'none'}
              style={{
                width: 5,
                height: 5,
                borderRadius: 1,
                background: level === null ? ACCENT[tab.provider] : `var(--${level})`,
              }}
            />
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
