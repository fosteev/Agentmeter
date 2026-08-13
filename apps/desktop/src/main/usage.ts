/**
 * Журнал наблюдений за лимитами и калибровка по нему (1.9).
 *
 * Наблюдение — это пара «процент окна, момент сброса», полученная **от
 * провайдера**: в логах Claude процента нет ни в каком виде. Единственный
 * источник с 7.5 — ответ на запрос к Anthropic (6.3), он же пишет сюда; до 7.5
 * рядом стоял хук строки состояния Claude Code, снятый вместе с потолками
 * плана (строку состояния рисует только терминальный CLI, в VS Code её нет
 * вовсе, и на живой машине хук за месяц не дал ни одного наблюдения против 54
 * ответов провайдера).
 *
 * Журнал переживает пересборку индекса и лежит рядом с ним, а не внутри:
 * наблюдения ретроспективе не поддаются — процент окна, которое уже сброшено,
 * не узнает никто.
 */
import {
  appendUsageJournal,
  calibrate,
  readClaudeRequests,
  readUsageJournal,
  usageKeys,
  type Calibration,
  type Db,
  type UsageSnapshot,
} from '@agentmeter/core'
import { join } from 'node:path'

/** Что модулю нужно от машины: один каталог, где лежит журнал. */
export interface UsageHost {
  configDir: string
}

export function journalPath(host: UsageHost): string {
  return join(host.configDir, 'usage.jsonl')
}

/**
 * Журнал наблюдений в памяти: что уже записано и что из этого вышло.
 *
 * Ключи прочитанного держатся множеством, а не сверкой с файлом на каждую
 * запись: ответы провайдера приходят раз в четверть часа и повторяют друг
 * друга процентом, пока человек не работает.
 */
export interface UsageJournal {
  path: string
  seen: Set<string>
  snapshots: UsageSnapshot[]
  calibration: Calibration | null
  /** Когда калибровка считалась последний раз — вход троттлинга. */
  calibratedAt: number
}

export function openJournal(host: UsageHost): UsageJournal {
  const path = journalPath(host)
  const snapshots = readUsageJournal(path)
  return {
    path,
    seen: new Set(snapshots.flatMap(usageKeys)),
    snapshots,
    calibration: null,
    calibratedAt: 0,
  }
}

/**
 * Записать наблюдение, если оно новое.
 *
 * Дедуп — по паре (процент, момент сброса) каждого окна: запись попадает в
 * журнал, если **хоть один** её ключ новый. `false` означает «уже знали»: ответ,
 * повторивший прошлый, ничего к журналу не добавил, и пересчитывать по нему
 * калибровку — работа впустую.
 */
export function rememberSnapshot(journal: UsageJournal, snapshot: UsageSnapshot): boolean {
  const keys = usageKeys(snapshot)
  if (keys.every((key) => journal.seen.has(key))) return false
  appendUsageJournal(journal.path, [snapshot])
  for (const key of keys) journal.seen.add(key)
  journal.snapshots.push(snapshot)
  return true
}

/**
 * Пересчитать вес и потолки по журналу.
 *
 * Запросы читаются не за всю историю, а начиная с самого старого окна в
 * журнале: калибровке нужны дни, а не месяцы, а полный проход по запросам
 * Claude — это работа, которую нельзя делать на каждый ответ провайдера.
 */
export function recalibrate(db: Db, journal: UsageJournal, at = Date.now()): Calibration {
  const from = earliestWindowStart(journal.snapshots)
  const calibration = calibrate(journal.snapshots, readClaudeRequests(db, from))
  journal.calibration = calibration
  journal.calibratedAt = at
  return calibration
}

const WEEK_MS = 7 * 24 * 3_600_000

function earliestWindowStart(snapshots: readonly UsageSnapshot[]): number {
  let earliest = Number.POSITIVE_INFINITY
  for (const snapshot of snapshots) {
    if (snapshot.fiveHour) earliest = Math.min(earliest, snapshot.fiveHour.resetsAt - 5 * 3_600_000)
    if (snapshot.weekly) earliest = Math.min(earliest, snapshot.weekly.resetsAt - WEEK_MS)
  }
  return Number.isFinite(earliest) ? earliest : 0
}
