import type { ClaudeLimits } from '@agentmeter/core'
import type { Calibration } from '@agentmeter/core'
import type { DeepPartial } from '@agentmeter/ipc'

/**
 * Что калибровка 1.9 записывает в настройки.
 *
 * Отдельным модулем — потому что это единственное место, где измеренное число
 * попадает в конфиг, и решение «писать или не писать» здесь важнее кода вокруг.
 * Внутри `index.ts` его не проверить: там живое приложение.
 *
 * Правило одно и с 7.4 без исключений: **сошлось — пишем**. Вес чтения кэша и
 * оба потолка живут только здесь; в логах их нет, спросить не у кого, и другого
 * источника у этих чисел не будет.
 *
 * Оговорка «кроме случая, когда человек выбрал план» стояла до 7.4 и делала
 * ровно обратное задуманному: заявленный тариф — 220 000 у «Max 20×» — навсегда
 * перебивал измеренный потолок. А потолок здесь во **взвешенных** токенах
 * (`I + W + O + w·R`), и объявленных тарифов в этих единицах не существует
 * вовсе, то есть перебивал он измерение выдумкой.
 */
export function calibrationPatch(
  current: ClaudeLimits,
  calibration: Calibration,
): DeepPartial<ClaudeLimits> {
  // `ok === false` означает «данных мало» — нормальный исход, при котором в
  // конфиг не едет ничего: правдоподобное число вместо признания незнания и
  // есть то враньё, ради борьбы с которым продукт затевался.
  if (!calibration.ok) return {}
  const patch: DeepPartial<ClaudeLimits> = {}
  // Порог у веса свой: он доля от нуля до единицы, и третий знак после запятой
  // — уже шум решения, а не новое знание. У потолков — токен.
  if (differs(current.cacheReadWeight, calibration.cacheReadWeight, 1e-3)) {
    patch.cacheReadWeight = calibration.cacheReadWeight
  }
  if (differs(current.fiveHourCap, calibration.fiveHourCap, 1)) {
    patch.fiveHourCap = calibration.fiveHourCap
  }
  if (differs(current.weeklyCap, calibration.weeklyCap, 1)) {
    patch.weeklyCap = calibration.weeklyCap
  }
  return patch
}

/** Разошлись ли числа настолько, чтобы переписывать настройку. */
export function differs(current: number | null, next: number | null, epsilon: number): boolean {
  if (next === null) return false
  return current === null || Math.abs(current - next) > epsilon
}
