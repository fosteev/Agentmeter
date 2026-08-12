import { LimitBar } from './LimitBar.tsx'

// Блок лимита в попапе — строки 433–440 макета: шапка с именем окна и
// процентом, под ней полоса, под ней тихая подпись про сброс.
//
// Бейджа провайдера здесь больше нет: провайдера называет таб над списком
// (416–429, этап 7.1), и вторая метка на строке повторяла бы его молча — а
// повтор в попапе шириной 400 точек стоит места, которого нет.
//
// Здесь живёт единственное место продукта, где «не знаем» обязано выглядеть не
// как ноль. У Claude до калибровки веса `cache_read` (этап 1.9) процента нет
// вовсе, и полоса рисуется пустой, процент — прочерком, а причина уходит в
// подпись вместо времени сброса. Ноль на этом месте означал бы «ничего не
// израсходовано», то есть ровно ту ложь, ради борьбы с которой затевался
// измерительный продукт.
//
// Цвет процента взят из макета и следует уровню, а не точности: ≈68% янтарны
// (строка 436), ≈31% и ≈12% уходят в tx2 (445, 454). То есть оценка приглушает
// число только там, где тревожить не о чем.
//
// Нейтральный процент в этом блоке макет больше не показывает — до табов там
// стоял Codex с 5%, а на вкладке Claude все три окна оценочные. Уровни при этом
// не переехали: их шкала нарисована у полосы лимита (176–181, «норма <60»).

export interface PopupLimitProps {
  /** Имя окна: «недельное окно», «5-часовое окно». */
  title: string
  percent: number | null
  /** Оценка: знак «≈» у числа и штриховка в полосе. */
  approximate: boolean
  /**
   * Нижняя строка: «сброс через 6 д 4 ч», а при неизвестном проценте — причина,
   * по которой его нет. Готовый текст, окно ничего не считает.
   */
  caption: string
}

/**
 * Уровень тревоги по проценту — одна шкала на число в строке и на точку таба
 * (7.1).
 *
 * Отдельной функцией именно затем, чтобы у табов не завелась своя копия порогов:
 * разъехавшись, они дали бы янтарное число под серой точкой, и человек поверил
 * бы точке — она видна раньше.
 */
export function limitLevel(percent: number | null): 'alarm' | 'warn' | null {
  if (percent === null) return null
  if (percent > 85) return 'alarm'
  if (percent >= 60) return 'warn'
  return null
}

function percentColor(percent: number | null, approximate: boolean): string | undefined {
  if (percent === null) return 'var(--tx3)'
  const level = limitLevel(percent)
  if (level !== null) return `var(--${level})`
  return approximate ? 'var(--tx2)' : undefined
}

export function PopupLimit({ title, percent, approximate, caption }: PopupLimitProps) {
  const known = percent !== null

  return (
    <div data-limit-row="" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12 }}>{title}</span>
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            color: percentColor(percent, approximate),
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {known ? `${approximate ? '≈' : ''}${Math.round(percent)}%` : '—'}
        </span>
      </div>
      <LimitBar percent={percent} approximate={approximate} size="popup" label={false} />
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          color: 'var(--tx3)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {caption}
      </div>
    </div>
  )
}
