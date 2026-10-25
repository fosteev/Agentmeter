/**
 * Логика окна первичной настройки (7.3), без разметки: что мастер спрашивает,
 * чем это пишется и как читается ход индексации.
 *
 * Главное правило этапа — **мастер не вводит настроек, которых нет в
 * «Настройках»**. Оно держится списком `SETUP_FIELDS`: каждый контрол мастера
 * назван в нём вместе с ручкой раздела настроек, которая пишет то же поле, и
 * тест (`setup.test.tsx`) прогоняет эти пары живьём. Контрол без пары краснеет.
 *
 * Пока человек листает шаги, конфиг не меняется: всё лежит в черновике и
 * уходит одним вызовом по «Начать». «Пропустить» — тот же вызов с пустым
 * патчем, то есть дефолты конфига, а не отдельный набор значений.
 */
import type { Config } from '@agentmeter/core'
import type {
  ConfigReport,
  DeepPartial,
  IndexProgress,
  SetupFinish,
  SetupScan,
} from '@agentmeter/ipc'

export const SETUP_STEPS = 3
export type SetupStepNumber = 1 | 2 | 3

/** Всё, что мастер спрашивает. Поля называются как в «Настройках». */
export interface SetupDraft {
  warnAtPercent: number
  dangerAtPercent: number
  notifyOnWaiting: boolean
  notifyOnDone: boolean
  hidePrompts: boolean
  theme: Config['ui']['theme']
  /** Согласие на запрос к Anthropic (`limits.claude.api.enabled`). */
  claudeApi: boolean
  /** Согласие на запрос к OpenAI (`limits.codex.api.enabled`). */
  codexApi: boolean
  updatesAuto: boolean
  /** Автозапуск — состояние операционной системы, не конфига. */
  startup: boolean
}

/** Каким входом «Настройки» пишут поле. */
export type SettingsWriter = 'config:set' | 'oauth:set' | 'startup:set'

export interface SetupField {
  /** Поле черновика, которым владеет контрол мастера. */
  draft: keyof SetupDraft
  /** Путь в конфиге; у автозапуска — `startup`, он живёт в системе. */
  path: string
  /** Ручка раздела настроек, пишущая то же поле: атрибут и значение. */
  control: readonly ['data-setting' | 'data-theme-choice', string]
  via: SettingsWriter
}

/**
 * Полный список того, что пишет мастер. Новый контрол начинается здесь.
 *
 * Снятое из макета (план, дорогая сессия, переплата за паузу, проценты в трее,
 * сбор истории, Kimi, Ollama) сюда не попадает намеренно: у него нет пары в
 * «Настройках», а значит, нет и права на место в мастере.
 */
export const SETUP_FIELDS: readonly SetupField[] = [
  { draft: 'warnAtPercent', path: 'alerts.warnAtPercent', control: ['data-setting', 'warn'], via: 'config:set' },
  { draft: 'dangerAtPercent', path: 'alerts.dangerAtPercent', control: ['data-setting', 'danger'], via: 'config:set' },
  { draft: 'notifyOnWaiting', path: 'alerts.notifyOnWaiting', control: ['data-setting', 'notifyOnWaiting'], via: 'config:set' },
  { draft: 'notifyOnDone', path: 'alerts.notifyOnDone', control: ['data-setting', 'notifyOnDone'], via: 'config:set' },
  { draft: 'hidePrompts', path: 'privacy.hidePrompts', control: ['data-setting', 'hidePrompts'], via: 'config:set' },
  { draft: 'theme', path: 'ui.theme', control: ['data-theme-choice', 'dark'], via: 'config:set' },
  { draft: 'claudeApi', path: 'limits.claude.api.enabled', control: ['data-setting', 'oauth'], via: 'oauth:set' },
  { draft: 'codexApi', path: 'limits.codex.api.enabled', control: ['data-setting', 'codex-oauth'], via: 'oauth:set' },
  { draft: 'updatesAuto', path: 'updates.auto', control: ['data-setting', 'updatesAuto'], via: 'config:set' },
  { draft: 'startup', path: 'startup', control: ['data-setting', 'launchAtLogin'], via: 'startup:set' },
]

/** Черновик из текущих значений: при повторном открытии мастер показывает выбранное. */
export function draftFromReport(report: ConfigReport): SetupDraft {
  const { config } = report
  return {
    warnAtPercent: config.alerts.warnAtPercent,
    dangerAtPercent: config.alerts.dangerAtPercent,
    notifyOnWaiting: config.alerts.notifyOnWaiting,
    notifyOnDone: config.alerts.notifyOnDone,
    hidePrompts: config.privacy.hidePrompts,
    theme: config.ui.theme,
    claudeApi: config.limits.claude.api.enabled,
    codexApi: config.limits.codex.api.enabled,
    updatesAuto: config.updates.auto,
    startup: report.startup.enabled,
  }
}

/** Патч конфига из черновика. Автозапуска в нём нет: он уходит отдельным полем. */
export function setupPatch(draft: SetupDraft): DeepPartial<Config> {
  return {
    alerts: {
      warnAtPercent: draft.warnAtPercent,
      dangerAtPercent: draft.dangerAtPercent,
      notifyOnWaiting: draft.notifyOnWaiting,
      notifyOnDone: draft.notifyOnDone,
    },
    privacy: { hidePrompts: draft.hidePrompts },
    ui: { theme: draft.theme },
    limits: {
      claude: { api: { enabled: draft.claudeApi } },
      codex: { api: { enabled: draft.codexApi } },
    },
    updates: { auto: draft.updatesAuto },
  }
}

/**
 * Аргумент «Начать».
 *
 * Автозапуск едет только когда его **меняли**: нетронутый тумблер не должен
 * лишний раз писать в «Объекты входа», и «Начать» с нетронутыми значениями
 * обязано не трогать вообще ничего, кроме флага мастера.
 */
export function finishArg(draft: SetupDraft, report: ConfigReport): SetupFinish {
  const arg: SetupFinish = { patch: setupPatch(draft) }
  if (draft.startup !== report.startup.enabled) arg.startup = draft.startup
  return arg
}

/** «Пропустить» и крестик окна: пустой патч — дефолты конфига, никаких своих значений. */
export function skipArg(): SetupFinish {
  return { patch: {} }
}

export interface SetupState {
  step: SetupStepNumber
  draft: SetupDraft
}

export type SetupAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'draft'; patch: Partial<SetupDraft> }

export function initialSetupState(report: ConfigReport): SetupState {
  return { step: 1, draft: draftFromReport(report) }
}

/**
 * Редьюсер мастера. Ничего не пишет: меняет только черновик и номер шага.
 *
 * Пороги держатся парой: предупреждение не выше тревоги. Загрузчик конфига
 * откатывает **пару целиком**, если порядок нарушен, — и «Начать» молча
 * потеряло бы оба значения, которые человек выбрал.
 */
export function setupReducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'next':
      return { ...state, step: Math.min(SETUP_STEPS, state.step + 1) as SetupStepNumber }
    case 'back':
      return { ...state, step: Math.max(1, state.step - 1) as SetupStepNumber }
    case 'draft': {
      const draft = { ...state.draft, ...action.patch }
      if (action.patch.warnAtPercent !== undefined) {
        draft.warnAtPercent = Math.min(draft.warnAtPercent, draft.dangerAtPercent)
      }
      if (action.patch.dangerAtPercent !== undefined) {
        draft.dangerAtPercent = Math.max(draft.dangerAtPercent, draft.warnAtPercent)
      }
      return { ...state, draft }
    }
  }
}

/** Как часто можно перечитывать найденное, пока идёт проход. */
export const RESCAN_EVERY_MS = 2_000

/**
 * Пора ли перечитать `setup:scan`.
 *
 * Файлы и байты за время мастера не меняются, а вот модели появляются по мере
 * того, как проход разбирает запросы. Поэтому перечитываем, пока проход идёт и
 * сдвинулся (не чаще раза в `RESCAN_EVERY_MS` — сам обход каталога не бесплатен),
 * и ещё раз, когда он закончился: последний кусок прохода событием не
 * объявляется, о конце говорит только исчезнувший `indexing` в снимке.
 */
export function shouldRescan(
  before: IndexProgress | undefined,
  after: IndexProgress | undefined,
  sinceLastMs: number,
): boolean {
  if (before !== undefined && after === undefined) return true
  if (after === undefined) return false
  return after.filesDone !== before?.filesDone && sinceLastMs >= RESCAN_EVERY_MS
}

/** Что сказать про индексацию в карточке «Что произойдёт дальше». */
export type SetupProgress =
  | { kind: 'unknown' }
  | { kind: 'nothing' }
  | { kind: 'reading'; percent: number; etaMs: number | null }
  | { kind: 'done' }

/**
 * Состояние прохода для строки мастера. Числа не пересчитываются: оценка
 * приезжает готовой (`IndexProgress.etaMs`, считает main), а доля — та же
 * подгонка под ширину, что и в попапе, по **байтам**, не по файлам.
 */
export function setupProgress(
  scan: SetupScan | null,
  snapshotKnown: boolean,
  indexing: IndexProgress | undefined,
): SetupProgress {
  if (scan === null || !snapshotKnown) return { kind: 'unknown' }
  if (scan.providers.every((provider) => provider.files === 0)) return { kind: 'nothing' }
  if (indexing === undefined) return { kind: 'done' }
  const percent =
    indexing.bytesTotal === 0
      ? 0
      : Math.round(Math.max(0, Math.min(1, indexing.bytesDone / indexing.bytesTotal)) * 100)
  return { kind: 'reading', percent, etaMs: indexing.etaMs }
}
