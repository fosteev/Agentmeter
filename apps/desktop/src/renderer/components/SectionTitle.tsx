import type { ReactNode } from 'react'

// Заголовок раздела попапа — строки 344–347 и 406–409 макета: слева
// разрядкой в верхнем регистре, справа что-нибудь тихое (счётчик агентов,
// подпись «≈ оценка»).
//
// Верхний отступ приходит параметром, а не зашит: у списка агентов он 14
// (строка 344), у лимитов 16 (строка 406). Это не разнобой — второй заголовок
// отбивается от списка строк, первый от шапки, и макет отвечает на оба вопроса
// разными числами.

export interface SectionTitleProps {
  title: string
  /** Готовые внутренние поля, например «14px 14px 4px». Числа — из макета. */
  padding?: string
  /** Правая часть: счётчик, подпись про точность. */
  aside?: ReactNode
}

export function SectionTitle({ title, padding, aside }: SectionTitleProps) {
  return (
    <div
      style={{
        padding,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          letterSpacing: '.14em',
          textTransform: 'uppercase',
          color: 'var(--tx3)',
        }}
      >
        {title}
      </span>
      {aside}
    </div>
  )
}
