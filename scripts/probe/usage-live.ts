/**
 * Настоящие лимиты Claude по живому журналу наблюдений (1.9).
 *
 *     node --experimental-strip-types scripts/probe/usage-live.ts
 *
 * Модель — [`docs/roadmap/1.9-usage.md`](../../docs/roadmap/1.9-usage.md).
 *
 * Проба честно печатает «данных мало» и выходит нулём, пока журнал не набран:
 * он копится днями, и первый прогон обязан быть таким. Провалом считается
 * другое — разобранный журнал, который **противоречит** модели: непредсказанные
 * границы окон, вес за пределами доли, разъехавшиеся между окнами потолки.
 * Проверка 2 при этом бесплатная сверка **чужой** модели: границы пятичасовых
 * окон предсказаны в 1.8 по нашим запросам, а здесь их сообщает провайдер.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CALIBRATION,
  buildClaudeWindows,
  calibrate,
  ingestAll,
  openDb,
  readClaudeRequests,
  readUsageJournal,
  usagePath,
  type Calibration,
  type Fit,
  type UsageSnapshot,
} from '../../packages/core/src/index.ts'

const MINUTE_MS = 60_000
const FIVE_HOURS_MS = 300 * MINUTE_MS

let failed = false
const temp = mkdtempSync(join(tmpdir(), 'agentmeter-usage-live-'))
const { db } = openDb(join(temp, 'index.sqlite'))

try {
  const path = usagePath()
  const journal = readUsageJournal(path)

  // 1. Журнал разобран. Пустой — не провал: пока проценты не спрошены у
  //    провайдера, их не знает никто, и ретроспективы этап не даёт.
  const fiveHourWindows = new Set(
    journal.map((snapshot) => snapshot.fiveHour?.resetsAt).filter(defined),
  )
  const weeklyWindows = new Set(
    journal.map((snapshot) => snapshot.weekly?.resetsAt).filter(defined),
  )
  report(
    1,
    'журнал',
    `${path}: снимков ${journal.length}, пятичасовых окон ${fiveHourWindows.size}, недельных ${weeklyWindows.size}${span(journal)}`,
    true,
  )
  if (journal.length === 0) {
    console.log(
      '  данных мало: журнал пуст — включите запрос лимитов у Anthropic в настройках («Лимиты»)',
    )
    process.exit(0)
  }

  const ingest = ingestAll(db)
  const requests = readClaudeRequests(db)
  const windows = buildClaudeWindows(requests, {
    fiveHourCap: null,
    weeklyCap: null,
    cacheReadWeight: null,
    plan: null,
  })
  const predicted = windows
    .filter((window) => window.kind === 'fiveHour')
    .map((window) => window.resetsAt)
    .sort((left, right) => left - right)

  // 2. Границы окон, предсказанные в 1.8 по нашим запросам, против границ,
  //    которые сообщает провайдер.
  //
  //    Сверяется **только по снимкам строки состояния**, и это не поблажка. У
  //    ответа `/api/oauth/usage` границы приезжают по аккаунту целиком, а наши
  //    якорятся на первом запросе этой машины — на живых данных расхождение
  //    вышло в три часа при том, что пятичасовой паузы в запросах не было
  //    вовсе (пункт 23 CLAUDE.md, 6.3). Считать это провалом предсказания
  //    значит требовать от одной машины знания про весь аккаунт. С 7.5 хука
  //    больше нет, и у нового журнала сверять здесь нечего — проверка молчит,
  //    а не притворяется пройденной.
  const local = journal.filter((snapshot) => (snapshot.source ?? 'statusline') === 'statusline')
  const localWindows = new Set(local.map((snapshot) => snapshot.fiveHour?.resetsAt).filter(defined))
  const distances = [...localWindows]
    .map((resetsAt) => nearest(predicted, resetsAt))
    .filter((distance) => Number.isFinite(distance))
  const within = distances.filter((distance) => distance <= MINUTE_MS).length
  const share = distances.length === 0 ? 0 : (within / distances.length) * 100
  report(
    2,
    'границы окон (сверка 1.8)',
    distances.length === 0
      ? 'снимков строки состояния в журнале нет: границы окон приезжают от провайдера и сверке с нашими не подлежат (6.3)'
      : `совпало ${within}/${distances.length} (${share.toFixed(1)}%) в пределах 60 с, медиана ${seconds(median(distances))}, порог 90%`,
    distances.length === 0 || share >= 90,
    distances.length === 0,
  )

  const calibration = calibrate(journal, requests)

  // 3. Отсев. Печатается всегда: молчаливо выброшенное окно — это выборка,
  //    про которую нельзя сказать, из чего она.
  const foreign = calibration.dropped.filter((window) => window.reason === 'foreign')
  const outliers = calibration.dropped.filter((window) => window.reason === 'cap-outlier')
  report(
    3,
    'отсев',
    `чужой расход: окон ${foreign.length}, точек ${foreign.reduce(points, 0)}; ` +
      `потолок врозь: окон ${outliers.length}, точек ${outliers.reduce(points, 0)}`,
    true,
  )

  // 4 и 5. Решение по каждому виду окна порознь: потолок у них разный.
  report(4, 'пятичасовые окна', describe(calibration.fiveHour), fitOk(calibration.fiveHour))
  report(5, 'недельные окна', describe(calibration.weekly), fitOk(calibration.weekly))

  // 6. Вес обязан совпасть между окнами — это проверка модели, а не пересчёт.
  const gap = calibration.weightGap
  report(
    6,
    'вес совпал между окнами',
    gap === null
      ? 'сравнивать нечего: решения нет хотя бы у одного вида окна'
      : `|w5ч − w7д| = ${gap.toFixed(4)}, порог ${CALIBRATION.maxWeightGap}`,
    gap === null || gap <= CALIBRATION.maxWeightGap,
    gap === null,
  )

  // 7. Вердикт — сводка, а не отдельный сторож: противоречия модели ловят
  //    проверки 4–6, и дублировать их красным здесь значило бы считать одну
  //    поломку дважды. Незелёный вердикт при зелёных 4–6 означает ровно одно:
  //    журнал ещё не набран.
  report(7, 'вердикт', verdict(calibration), calibration.ok, !calibration.ok)

  if (ingest.failed > 0) console.error(`  не разобралось файлов: ${ingest.failed}`)
} finally {
  db.close()
  rmSync(temp, { recursive: true, force: true })
}

if (failed) process.exit(1)

/**
 * `neutral` — исход, который не зелёный и не провал: данных пока не хватает.
 * Без него проба либо врала бы галочкой на пустом журнале, либо падала бы
 * каждый день до набора выборки, и её перестали бы запускать.
 */
function report(index: number, name: string, detail: string, ok: boolean, neutral = false): void {
  const mark = neutral ? '·' : ok ? '✓' : '✗'
  console.log(`${mark} ${index}. ${name}: ${detail}`)
  if (!ok && !neutral) failed = true
}

function describe(fit: Fit): string {
  const head = `точек ${fit.points}, окон ${fit.windows}, размах доли чтения кэша ${fit.shareSpread.toFixed(3)}`
  if (fit.weight === null) {
    const rejected =
      fit.rejected === undefined
        ? ''
        : `, отвергнуто w=${fit.rejected.weight.toFixed(4)} cap=${Math.round(fit.rejected.cap)}`
    return `${head}, решения нет (${fit.reason})${rejected}`
  }
  return (
    `${head}, w=${fit.weight.toFixed(4)}, cap=${Math.round(fit.cap!).toLocaleString('ru-RU')}, ` +
    `остаток ${fit.residualPp!.toFixed(2)} п.п. (порог ${CALIBRATION.maxResidualPp}), ` +
    `разброс потолков ${((fit.capSpread ?? 0) * 100).toFixed(1)}% (порог ${CALIBRATION.maxCapSpread * 100}%)`
  )
}

/**
 * Решение либо отсутствует (мало данных — это нормально), либо обязано быть
 * согласным с моделью. Вес за пределами доли и разъехавшиеся потолки — это не
 * «пока мало точек», а сообщение о том, что модель не описывает данные.
 */
function fitOk(fit: Fit): boolean {
  if (fit.weight === null) return fit.reason !== 'out-of-range'
  if ((fit.capSpread ?? 0) > CALIBRATION.maxCapSpread) return false
  return (fit.residualPp ?? 0) <= CALIBRATION.maxResidualPp
}

function verdict(calibration: Calibration): string {
  if (calibration.ok) {
    return (
      `вес чтения кэша ${calibration.cacheReadWeight!.toFixed(4)}, ` +
      `потолки ${Math.round(calibration.fiveHourCap!).toLocaleString('ru-RU')} / ` +
      `${Math.round(calibration.weeklyCap!).toLocaleString('ru-RU')} — уходит в настройки`
    )
  }
  const short = `нужно ${CALIBRATION.minPoints} точек из ${CALIBRATION.minWindows} пятичасовых окон`
  return `вес остаётся null, лимиты остаются оценкой; помехи: ${calibration.blockers.join(', ')} (${short})`
}

function points(sum: number, window: { points: number }): number {
  return sum + window.points
}

function defined(value: number | undefined): value is number {
  return value !== undefined
}

function span(journal: readonly UsageSnapshot[]): string {
  if (journal.length === 0) return ''
  const from = Math.min(...journal.map((snapshot) => snapshot.ts))
  const to = Math.max(...journal.map((snapshot) => snapshot.ts))
  const days = (to - from) / (24 * 3_600_000)
  return `, период ${new Date(from).toISOString().slice(0, 16)} … ${new Date(to).toISOString().slice(0, 16)} (${days.toFixed(1)} сут)`
}

/**
 * Насколько далеко предсказанная граница от приехавшей.
 *
 * Окна строятся только по нашим запросам, и если в окне не было ни одного —
 * предсказывать нечего. Такое окно из сверки выпадает, а не считается промахом:
 * это не ошибка модели 1.8, а отсутствие входа у неё.
 */
function nearest(predicted: readonly number[], resetsAt: number): number {
  let best = Number.POSITIVE_INFINITY
  for (const candidate of predicted) {
    const distance = Math.abs(candidate - resetsAt)
    if (distance < best) best = distance
  }
  return best > FIVE_HOURS_MS ? Number.NaN : best
}

function seconds(value: number): string {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(1)} с` : 'n/a'
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}
