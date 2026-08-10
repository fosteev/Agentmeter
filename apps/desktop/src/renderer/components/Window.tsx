import type { ReactNode } from 'react'
import type { TraySnapshot } from '@agentmeter/ipc'
import { WindowHeader } from './WindowHeader.tsx'
import type { WindowTab } from './WindowTabs.tsx'

export interface WindowProps {
  snapshot: TraySnapshot
  activeTab: WindowTab
  onTabChange: (tab: WindowTab) => void
  children: ReactNode
}

/**
 * Рамки и скругления у окна нет, хотя в макете они нарисованы (строка 564).
 *
 * Там нарисовано окно операционной системы целиком — вместе с её кнопками,
 * тенью и скруглением. У нас всё это рисует система: окно поднимается с обычной
 * рамкой, и своё скругление в 12 точек внутри прямоугольной рамки дало бы
 * четыре угла, сквозь которые видно фон, а рамка в один пиксель — вторую
 * границу вплотную к настоящей. В витрине карточка обрамляется снаружи, там это
 * действительно образец на листе.
 */
export function Window({ snapshot, activeTab, onTabChange, children }: WindowProps) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--bg)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <WindowHeader snapshot={snapshot} activeTab={activeTab} onTabChange={onTabChange} />
      <main
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 300px',
          minHeight: 0,
        }}
      >
        {children}
      </main>
    </div>
  )
}
