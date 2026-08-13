import type { Provider } from '@agentmeter/core'
import type { CodexApiStatus, UsageApiStatus } from '@agentmeter/ipc'
import { t } from '../format.ts'
import { ago, span } from '../time.ts'
import { SectionTitle } from './SectionTitle.tsx'
import { Switch } from './Switch.tsx'

/**
 * «Спрашивать проценты у провайдера» — блок раздела «Лимиты» (6.3, 6.4).
 *
 * Здесь то единственное, что доводит проценты лимита до попапа: у Claude их в
 * логах нет вовсе, у Codex они есть, но написаны в момент последнего запроса.
 *
 * Карточка хука строки состояния стояла тут первой до 7.5 и была снята вместе с
 * потолками. Причина не «сложно», а «не работает у половины»: строку состояния
 * рисует только терминальный Claude Code, в VS Code её нет вовсе — на живой
 * машине хук стоял месяц и не дал **ни одного** наблюдения, пока рядом лежало
 * 54 ответа провайдера. Экран, на котором тумблер месяцами показывает «0
 * снимков», не сообщает о себе ничего, кроме собственной бесполезности.
 *
 * Оба тумблера здесь — согласие ходить в сеть чужими креденшелами, поэтому
 * слово «запрос» стоит в первой строке подписи, а не в README.
 */
export interface SettingsUsageProps {
  /**
   * Запрос к Anthropic (6.3) — первая карточка блока.
   */
  api: UsageApiStatus
  /**
   * Вторая карточка — второй источник лимитов Codex (6.4).
   *
   * Отвечает на другой вопрос, чем соседняя. У Claude процента в логах нет
   * вовсе, и карточка выше его **добывает**. У Codex процент есть и он точный,
   * но написан в момент запроса — эта карточка обновляет его возраст, а не
   * само число.
   */
  codexApi: CodexApiStatus
  /** Разрешить или запретить запрос к провайдеру (6.3, 6.4). */
  onApiToggle: (provider: Provider, enabled: boolean) => void
  /**
   * Спросить проценты прямо сейчас — у всех разрешённых источников.
   *
   * Кнопка **ходит в сеть** — потому и называется «Спросить сейчас»: человек
   * вправе понимать, что она отправит его токен наружу.
   */
  onApiRefresh: () => void
  /** «Сейчас» для возраста снимка. Параметром — иначе витрину не проверить. */
  now?: number
}

export function SettingsUsage({
  api,
  codexApi,
  onApiToggle,
  onApiRefresh,
  now = Date.now(),
}: SettingsUsageProps) {
  // Кнопка одна на блок, а не по кнопке в карточке: канал спрашивает **все**
  // включённые источники разом, и две кнопки, делающие одно, врали бы каждая
  // про свою карточку — «Спросить сейчас» под Codex уводила бы в сеть и токен
  // Anthropic. Пока оба источника выключены, кнопки нет: ходить некуда.
  const ask =
    api.enabled || codexApi.enabled ? (
      <button type="button" data-usage-action="ask" onClick={onApiRefresh} style={CHIP}>
        {t('settings.oauthRefresh')}
      </button>
    ) : undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionTitle title={t('settings.usage')} aside={ask} />
      <div style={CARD}>
        <Switch
          name="oauth"
          label={api.enabled ? t('settings.oauthOn') : t('settings.oauthOff')}
          note={t('settings.oauthNote')}
          checked={api.enabled}
          onChange={(enabled) => onApiToggle('claude', enabled)}
        />

        {api.enabled ? (
          <>
            <span style={NOTE} data-oauth-credentials={api.credentials}>
              {t(CREDENTIALS[api.credentials])}
            </span>

            <span style={NOTE} data-oauth-state="">
              {fetched(api, now)}
            </span>

            {api.problem === undefined ? null : (
              <span style={{ ...NOTE, color: 'var(--alarm)' }} data-oauth-problem="">
                {api.problem}
              </span>
            )}
          </>
        ) : null}
      </div>

      <div style={CARD}>
        <Switch
          name="codex-oauth"
          label={codexApi.enabled ? t('settings.codexApiOn') : t('settings.codexApiOff')}
          note={t('settings.codexApiNote')}
          checked={codexApi.enabled}
          onChange={(enabled) => onApiToggle('codex', enabled)}
        />

        {codexApi.enabled ? (
          <>
            <span style={NOTE} data-codex-oauth-credentials={codexApi.credentials}>
              {t(CODEX_CREDENTIALS[codexApi.credentials])}
            </span>

            <span style={NOTE} data-codex-oauth-state="">
              {codexFetched(codexApi, now)}
            </span>

            {codexApi.problem === undefined ? null : (
              <span style={{ ...NOTE, color: 'var(--alarm)' }} data-codex-oauth-problem="">
                {codexApi.problem}
              </span>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

/** Ключи, а не подписи: `t()` на верхнем уровне застыл бы на языке загрузки. */
const CREDENTIALS = {
  file: 'settings.oauthCredsFile',
  keychain: 'settings.oauthCredsKeychain',
  missing: 'settings.oauthCredsMissing',
} as const satisfies Record<UsageApiStatus['credentials'], string>

/**
 * Что показать про последний ответ.
 *
 * Возраст обязателен, и это не украшение: снимок минутной давности и снимок
 * часовой выглядят одинаково, пока не написано, который из них какой, — а
 * запрос идёт раз в четверть часа, и при отказе на экране остаётся прежний.
 *
 * Действующее окно ограничения важнее возраста: пока оно не истекло, кнопка
 * ничего не даст, и человек должен видеть причину, а не думать, что она сломана.
 */
function fetched(api: UsageApiStatus, now: number): string {
  if (api.retryAt !== undefined && api.retryAt > now) {
    return t('settings.oauthRetry', { at: span(api.retryAt - now) })
  }
  if (api.fetchedAt === undefined) return t('settings.oauthNever')
  const when = ago(Math.max(0, now - api.fetchedAt))
  if (api.fiveHourPct === undefined && api.weeklyPct === undefined) {
    return t('settings.oauthFetchedFew', { ago: when })
  }
  return t('settings.oauthFetched', {
    ago: when,
    fiveHour: api.fiveHourPct ?? 0,
    weekly: api.weeklyPct ?? 0,
  })
}

/** Ключи, а не подписи, по той же причине, что у соседа выше. */
const CODEX_CREDENTIALS = {
  file: 'settings.codexApiCredsFile',
  expired: 'settings.codexApiCredsExpired',
  missing: 'settings.codexApiCredsMissing',
} as const satisfies Record<CodexApiStatus['credentials'], string>

/** Названия видов окон — те же, что в попапе: одно окно, одно слово. */
const KIND_KEY = {
  fiveHour: 'limit.fiveHour',
  weekly: 'limit.weekly',
  monthly: 'limit.monthly',
  other: 'limit.other',
} as const satisfies Record<NonNullable<CodexApiStatus['windows']>[number]['kind'], string>

/**
 * Что показать про последний ответ OpenAI.
 *
 * Окна перечисляются списком, а не парой «5 ч / 7 дней», как у Claude, и это не
 * прихоть: у Codex вид окна пришёл длиной, и до CLI 0.145.0 оно было
 * пятичасовым, после — недельным (пункт 8). Пара полей заставила бы выбирать,
 * куда положить окно, которое ни то и ни другое, — то есть выбросить его.
 */
function codexFetched(api: CodexApiStatus, now: number): string {
  if (api.retryAt !== undefined && api.retryAt > now) {
    return t('settings.codexApiRetry', { at: span(api.retryAt - now) })
  }
  if (api.fetchedAt === undefined) return t('settings.codexApiNever')
  const when = ago(Math.max(0, now - api.fetchedAt))
  const windows = api.windows ?? []
  if (windows.length === 0) return t('settings.codexApiFetchedFew', { ago: when })
  return t('settings.codexApiFetched', {
    ago: when,
    windows: windows
      .map((window) => `${t(KIND_KEY[window.kind])} — ${window.pct}%`)
      .join(', '),
  })
}

const CARD = {
  padding: '11px 12px',
  background: 'var(--s1)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const

const NOTE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  color: 'var(--tx3)',
} as const

/** Тот же вид кнопки, что у «Проверить» в разделе «Приложение». */
const CHIP = {
  padding: '4px 9px',
  border: 0,
  borderRadius: 5,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
  cursor: 'pointer',
  background: 'var(--s2)',
  color: 'var(--tx)',
  flex: 'none',
} as const
