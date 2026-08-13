/**
 * Настройки: чтение, запись и применение на живом приложении (3.6).
 *
 * До 3.6 канал `config:set` был честной заглушкой — возвращал пустой список
 * замечаний и ничего не делал. Здесь он начинает писать файл и применять
 * изменения, и главное правило одно: **применённым считается только то, что
 * видно без перезапуска**. Настройка, которая доедет до поведения лишь после
 * рестарта, обязана быть либо применена сразу, либо названа вслух — молчаливое
 * «сохранено, но не работает» это ровно то враньё, от которого продукт
 * отговаривает пользователя в других местах.
 *
 * Что применяется на ходу и как:
 *
 * - **язык** — `setLocale`: строки main собираются при вызове, а окно
 *   перерисовывается по событию `config:changed`;
 * - **тема, начало суток, приватность** — их читает окно из того же события;
 * - **пороги живого слоя и потолки лимитов** — правкой того самого объекта
 *   настроек, который держит живой слой: `collectAgents` читает его на каждом
 *   снимке, поэтому новое значение работает со следующего опроса;
 * - **опрос и вотчер** — их перезапускает `index.ts`, потому что таймер и
 *   наблюдатель живут там.
 *
 * Единственное, что переживает только перезапуск, — путь к логам: сменить его
 * значит пересобрать индекс, и это отдельная кнопка «Перечитать».
 */
import { existsSync } from 'node:fs'
import {
  applyPatch,
  claudeHome,
  codexHome,
  configPath,
  saveConfig,
  setLocale,
  type Config,
  type Db,
  type LiveLayerOptions,
  type Provider,
} from '@agentmeter/core'
import type { ConfigReport, DeepPartial, SourceStatus } from '@agentmeter/ipc'
import { readStartup, writeStartup, type StartupHost } from './startup.ts'
import type { UsageJournal } from './usage.ts'
import { oauthStatus, type OauthHost, type OauthState } from './oauth.ts'
import {
  codexOauthStatus,
  type CodexOauthHost,
  type CodexOauthState,
} from './codex-oauth.ts'
import type { UpdateState } from './update.ts'

/** Что настройкам нужно от приложения, чтобы примениться без перезапуска. */
export interface ConfigTarget {
  db: Db
  config: Config
  /**
   * Тот самый объект, который держит живой слой. Правится по месту, а не
   * подменяется: слой захватил ссылку при создании и читает поля на каждом
   * снимке — новый объект он бы не увидел, а пересоздание слоя стоило бы
   * потерянного кэша хвостов и журнала времён жизни.
   */
  liveOptions: LiveLayerOptions
  /** Замечания к файлу настроек — то, что не понято и заменено. */
  configProblems: string[]
  /**
   * Чем спрашивать систему про автозапуск (5.3). Не `app` целиком: в тестах
   * Electron нет, а поведение проверять надо — и именно поведение, а не то,
   * что мы записали себе в память.
   */
  startup: StartupHost
  /** Ход обновления (5.4) — состояние загрузчика, а не настройка из файла. */
  update: UpdateState
  /** Журнал наблюдений за лимитами и последняя калибровка по нему (1.9). */
  usage: UsageJournal
  /** Чем спрашивать Anthropic про лимиты (6.3) — пути и `fetch`, не `app`. */
  oauthHost: OauthHost
  /** Последний ответ Anthropic, окно ограничения и 401 — всё, что живёт в памяти. */
  oauth: OauthState
  /** То же для OpenAI и лимитов Codex (6.4). */
  codexOauthHost: CodexOauthHost
  codexOauth: CodexOauthState
}

/**
 * Записать правку и применить её.
 *
 * Порядок важен: сначала проверка и файл, потом живое применение. Примени
 * сперва — и отвергнутое загрузчиком значение успело бы поработать.
 */
export function setConfig(target: ConfigTarget, patch: DeepPartial<Config>): ConfigReport {
  const { config, problems } = applyPatch(target.config, patch)
  saveConfig(config, configPath())
  target.config = config
  target.configProblems = problems
  apply(target)
  return configReport(target)
}

/** Применить текущий конфиг к тому, что работает прямо сейчас. */
export function apply(target: ConfigTarget): void {
  setLocale(target.config.ui.locale)
  target.liveOptions.idleMs = target.config.live.idleMs
  target.liveOptions.codexSilenceMs = target.config.live.codexSilenceMs
  target.liveOptions.claudeLimits = target.config.limits.claude
}

export function configReport(target: ConfigTarget): ConfigReport {
  return {
    config: target.config,
    problems: target.configProblems,
    sources: sourceStatus(target.db, target.config),
    startup: readStartup(target.startup),
    update: target.update,
    usageApi: oauthStatus(target.oauthHost, target.oauth, target.config.limits.claude.api.enabled),
    codexApi: codexOauthStatus(
      target.codexOauthHost,
      target.codexOauth,
      target.config.limits.codex.api.enabled,
    ),
  }
}

/**
 * Включить или выключить запрос лимитов у провайдера (6.3, 6.4).
 *
 * В отличие от хука строки состояния, эта настройка живёт в **нашем** файле —
 * согласие на сетевой вызов хранить больше негде. И в отличие от остальных
 * полей конфига, у неё отдельный канал: включение попутно, вместе с темой
 * оформления, не должно быть возможно.
 *
 * Запроса отсюда не делается. Тумблер означает «разрешаю спрашивать», а не
 * «спроси сейчас»: первый запрос уйдёт по таймеру или по кнопке, когда человек
 * дочитает, что он включил.
 */
export function setOauth(
  target: ConfigTarget,
  provider: Provider,
  enabled: boolean,
): ConfigReport {
  // Выключение стирает и накопленное в памяти: оставь мы прежний ответ, экран
  // показывал бы проценты под выключенным тумблером, и выглядело бы это так,
  // будто приложение продолжает ходить в сеть.
  if (provider === 'claude') {
    if (!enabled) {
      delete target.oauth.snapshot
      delete target.oauth.fetchedAt
      delete target.oauth.problem
      delete target.oauth.throttle
      target.oauth.needsLogin = false
    }
    return setConfig(target, { limits: { claude: { api: { enabled } } } })
  }

  if (!enabled) {
    delete target.codexOauth.windows
    delete target.codexOauth.fetchedAt
    delete target.codexOauth.problem
    delete target.codexOauth.throttle
    target.codexOauth.needsLogin = false
  }
  return setConfig(target, { limits: { codex: { api: { enabled } } } })
}

/**
 * Переключить автозапуск и вернуть отчёт с тем, что вышло.
 *
 * Файла настроек это не касается вовсе: состояние живёт в системе. Отчёт
 * возвращается целиком тот же, что у `config:get`, — окну незачем знать, что
 * этот тумблер устроен иначе остальных.
 */
export function setStartup(target: ConfigTarget, enabled: boolean): ConfigReport {
  writeStartup(target.startup, enabled)
  return configReport(target)
}

/**
 * Строки блока «Пути к логам» — раздел 6 макета, строки 1181–1195.
 *
 * Число файлов и размер берутся **из индекса**, а не обходом каталога: обход
 * ради экрана настроек — это второй проход по 570 МБ на каждое открытие
 * вкладки, и он же однажды разойдётся с тем, что приложение на самом деле
 * прочитало. Существование каталога при этом проверяется на диске: индекс
 * помнит вчерашний том, который сегодня не смонтирован, и «✓ 412 файлов» над
 * отсутствующим путём — это ровно та бодрая цифра, которой здесь быть нельзя.
 */
function sourceStatus(db: Db, config: Config): SourceStatus[] {
  const rows = db.all<{ provider: string; files: number; bytes: number }>(
    'SELECT provider, count(*) AS files, coalesce(sum(size), 0) AS bytes FROM sources GROUP BY provider',
  )
  const found = new Map(rows.map((row) => [row.provider, row]))
  return [
    status('claude', claudeHome(config), found.get('claude')),
    status('codex', codexHome(config), found.get('codex')),
  ]
}

function status(
  provider: 'claude' | 'codex',
  path: string,
  row: { files: number; bytes: number } | undefined,
): SourceStatus {
  return {
    provider,
    path,
    readable: existsSync(path),
    files: row?.files ?? 0,
    bytes: row?.bytes ?? 0,
  }
}
