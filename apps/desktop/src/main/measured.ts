/**
 * Перевод «это восстановлено» в точность контракта — один на все сборщики.
 *
 * Копий было две (снимок трея и день), с карточкой задачи стало бы три, а текст
 * оговорки виден пользователю: он всплывает подсказкой у знака `≈`. Три копии
 * одной пользовательской фразы — это три места, где её правят по одному, и в
 * 3.8 три ключа перевода вместо одного.
 */
import { t } from '@agentmeter/core'
import type { Measured } from '@agentmeter/ipc'

/**
 * Восстановленное (1.3) — всегда `cache_read`, поэтому оговорка вешается на
 * него и на сумму, которая содержит его внутри себя. `input` и `output`
 * прочитаны как есть, и помечать их оценкой нечестно в другую сторону.
 */
export function measured(value: number, approximate: boolean): Measured {
  return approximate
    ? { value, confidence: 'reconstructed', caveat: t('caveat.reconstructed') }
    : { value, confidence: 'exact' }
}

/**
 * Число, у которого известна только нижняя граница: лога за эти сутки больше
 * нет, и сколько там было — неизвестно (M5, «Ретеншн индекса»).
 *
 * Не `reconstructed`: у восстановленного погрешность измерена (≤ 3.3%), а здесь
 * неизвестен сам порядок. Поэтому `estimate` — та же точность, что у выведенного
 * размера окна контекста.
 */
export function lowerBound(value: number): Measured {
  return { value, confidence: 'estimate', caveat: t('caveat.vanishedLog') }
}
