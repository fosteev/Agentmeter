export function hatch(color: string): string {
  return `repeating-linear-gradient(115deg, ${color} 0 3px, color-mix(in oklch, ${color} 32%, transparent) 3px 7px)`
}

/**
 * Ступень светлоты внутри тона провайдера — цвет модели в развёртке
 * «проекты × модели» (8.2). Тон кодирует провайдера, ступень — модель, новых
 * тонов не заводится (раздел 12 макета).
 *
 * Ступени — прозрачностью через `color-mix`, а не литералами oklch из макета:
 * литерал отвязался бы от темы канваса (в компонентах он и запрещён приёмкой).
 * Доли подобраны по самому макету: его вторая ступень `oklch(0.645 0.105 62)`
 * — это базовый тон на 78% поверх дорожки `--s2` тёмной темы, третья
 * `oklch(0.520 0.072 62)` — на 52%; дальше ряд продолжен тем же шагом. Хвост
 * ряда общий: моделей глубже шестой ступени глазом уже не развести, и это
 * ровно тот хвост, который легенда сворачивает строкой со своим числом.
 */
const MODEL_STEPS = [100, 78, 52, 34, 22, 14] as const

export function modelTone(provider: 'claude' | 'codex', step: number): string {
  const mix = MODEL_STEPS[Math.min(step, MODEL_STEPS.length - 1)]!
  const base = `var(--${provider})`
  return mix === 100 ? base : `color-mix(in oklch, ${base} ${mix}%, transparent)`
}
