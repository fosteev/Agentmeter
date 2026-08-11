import type { ReactNode } from 'react'

// Рамка попапа — одна на все пять состояний (2.8). Раньше эти двенадцать строк
// стиля лежали пятью копиями, и правка в одной означала, что четыре попапа
// теперь другого размера, — заметить это можно было только открыв все пять.

/** Ширина попапа из макета (строка 332). Окно создаётся ровно такой. */
export const POPUP_WIDTH = 400
/**
 * Потолок высоты из макета. Именно потолок: высота считается по содержимому, и
 * до 600 дорастает только длинный список агентов. То же число знает main
 * (`POPUP_MAX_HEIGHT`) — оно там про окно, здесь про содержимое, и сойтись им
 * положено по макету, а не по общему импорту: main в вёрстку не ходит.
 */
export const POPUP_MAX_HEIGHT = 600

export interface PopupShellProps {
  children: ReactNode
}

export function PopupShell({ children }: PopupShellProps) {
  return (
    <div
      style={{
        width: POPUP_WIDTH,
        // Потолок приезжает переменной: на маленьком экране он ниже макетного,
        // и знает об этом только окно (`useFitWindow`). Значение по умолчанию —
        // для витрины и тестов, где никакого окна нет.
        maxHeight: `var(--popup-max-height, ${POPUP_MAX_HEIGHT}px)`,
        // Граница считается внутрь. Без этого рамка в один пиксель делала
        // содержимое 402×602 в окне 400×600 — и прокручивалось само окно,
        // поверх интерфейса, у которого прокрутка своя и в другом месте.
        boxSizing: 'border-box',
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  )
}
