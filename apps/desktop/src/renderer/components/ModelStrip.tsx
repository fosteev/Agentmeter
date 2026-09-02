/**
 * Полоса, поделённая по моделям, — примитив раздела 12 макета (8.2).
 *
 * Два вида одной полосы. Полоса периода (строки 2108–2113) занимает всю ширину
 * и делит её пропорциями сегментов — дорожки под ней нет, потому что сравнивать
 * её не с чем: она сама и есть целое. Полоса строки (2149) лежит на дорожке
 * `--s2` и занимает долю от неё: длина сравнивает строку с самой длинной, и
 * дорожка показывает, докуда та достаёт.
 *
 * Вся арифметика здесь — подгонка долей под доступную ширину; это ровно та
 * доля-длина, которую правило 3.0 отдаёт окну. Сами доли приезжают числами из
 * main. Минимальной ширины у сегмента нет намеренно: сегмент, растянутый до
 * видимости, — то самое враньё, ради борьбы с которым продукт написан; состав
 * крошечной полосы читается по точкам моделей и раскрытию строки, не по ней.
 */
export interface StripSegment {
  key: string
  color: string
  /** Доля от полосы (не от дорожки): сегменты полной полосы дают в сумме 1. */
  share: number
}

export interface ModelStripProps {
  segments: StripSegment[]
  height: number
  /**
   * Доля дорожки, занятая полосой (строка против самой длинной). Без неё
   * рисуется полоса периода: вся ширина, зазор 3 и скругление по краям.
   */
  width?: number
}

export function ModelStrip({ segments, height, width }: ModelStripProps) {
  if (width === undefined) {
    return (
      <div data-model-strip="period" style={{ display: 'flex', gap: 3, height }}>
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            data-model-segment={segment.key}
            style={{
              flex: `${segment.share} ${segment.share} 0%`,
              background: segment.color,
              borderRadius: `${index === 0 ? 6 : 0}px ${index === segments.length - 1 ? '6px 6px' : '0 0'} ${index === 0 ? 6 : 0}px`,
            }}
          />
        ))}
      </div>
    )
  }
  return (
    <div
      data-model-strip="bar"
      style={{ height, borderRadius: 2, background: 'var(--s2)', overflow: 'hidden' }}
    >
      <div style={{ width: `${width * 100}%`, height: '100%', display: 'flex', gap: 1 }}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            data-model-segment={segment.key}
            style={{ width: `${segment.share * 100}%`, background: segment.color }}
          />
        ))}
      </div>
    </div>
  )
}
