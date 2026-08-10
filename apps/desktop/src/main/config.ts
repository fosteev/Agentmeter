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
} from '@agentmeter/core'
import type { ConfigReport, DeepPartial, SourceStatus } from '@agentmeter/ipc'
import { readStartup, writeStartup, type StartupHost } from './startup.ts'
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
  }
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
 * Строки блока «Пути к логам» — раздел 6 макета, строки 1131–1141.
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
