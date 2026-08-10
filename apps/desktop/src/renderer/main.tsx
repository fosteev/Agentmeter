import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Config } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import './tokens.css'
import { Popup } from './components/Popup.tsx'
import { setLocale } from './format.ts'

// Точка монтирования попапа. Данные — только через мост из preload: имён
// каналов строками здесь нет, клиент собран по контракту.

/**
 * Тема приезжает не отдельным каналом, а системным `prefers-color-scheme`:
 * main выставляет `nativeTheme.themeSource` из `ui.theme`, и при `system`
 * Electron отдаёт окну настоящую системную. Поэтому переключение работает без
 * перезапуска, а вся светлая палитра — это уже описанный в `tokens.css`
 * `[data-theme='light']`.
 */
function useTheme(): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => {
      media.removeEventListener('change', apply)
    }
  }, [])
}

function App() {
  const [snapshot, setSnapshot] = useState<TraySnapshot | null>(null)
  useTheme()

  useEffect(() => {
    let alive = true
    void window.agentmeter['config:get']().then(({ config }) => {
      setLocale((config as Config).ui.locale)
    })
    void window.agentmeter['snapshot:get']().then((first) => {
      if (alive) setSnapshot(first)
    })
    const off = window.agentmeter['on:live:update']((next) => {
      setSnapshot(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // Пустых состояний здесь нет намеренно: «пусто», «индексирование», «ошибка» и
  // «никого нет» нарисованы в разделе 7 макета и делаются этапом 2.8. До первого
  // снимка попап просто ничего не рисует, а не выдумывает свой экран.
  if (snapshot === null) return null
  return (
    <Popup
      snapshot={snapshot}
      onOpenWindow={() => {
        void window.agentmeter['window:open']({ tab: 'today' })
      }}
    />
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
