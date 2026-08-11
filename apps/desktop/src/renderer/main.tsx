import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Config } from '@agentmeter/core'
import type { TraySnapshot } from '@agentmeter/ipc'
import './tokens.css'
import { Popup } from './components/Popup.tsx'
import { POPUP_MAX_HEIGHT } from './components/PopupShell.tsx'
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

/**
 * Окно попапа — ростом с содержимое.
 *
 * Меряет рендерер, ставит main: сколько получилось строк агентов и полос
 * лимита, видно только после вёрстки — это зависит и от языка, и от длины
 * названия проекта, и от того, перенеслась ли строка. Зашитые 600 давали
 * пустое поле под коротким содержимым, а с рамкой в один пиксель ещё и
 * прокрутку у самого окна.
 *
 * Потолок содержимого — не только макетные 600, но и рабочая область экрана:
 * рамка попапа обрезает лишнее без всякого скролла, и на маленьком дисплее
 * подвал с суммой за сутки исчез бы молча. Экран может смениться вместе с
 * положением окна, поэтому потолок пересчитывается на каждом изменении
 * размера, а не один раз при загрузке.
 */
function useFitWindow(): void {
  useEffect(() => {
    const root = document.getElementById('root')
    if (root === null) return

    // Тот же зазор, что у `POPUP_MARGIN` в main: там он о положении окна, здесь
    // о высоте содержимого, и разъехаться им нельзя — иначе main отдаст меньше,
    // чем окно нарисовало, и разницу срежет.
    const ceiling = (): void => {
      const room = window.screen.availHeight - 16
      document.documentElement.style.setProperty(
        '--popup-max-height',
        `${Math.min(POPUP_MAX_HEIGHT, room)}px`,
      )
    }
    ceiling()
    window.addEventListener('resize', ceiling)

    let last = 0
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(root.getBoundingClientRect().height)
      // Ноль — это «рисовать ещё нечего»: до первого снимка попап пуст
      // намеренно, и подгонять окно под пустоту значит моргнуть полоской.
      if (height === 0 || height === last) return
      last = height
      void window.agentmeter['popup:resize']({ height })
    })
    observer.observe(root)

    return () => {
      window.removeEventListener('resize', ceiling)
      observer.disconnect()
    }
  }, [])
}

function App() {
  const [snapshot, setSnapshot] = useState<TraySnapshot | null>(null)
  useTheme()
  useFitWindow()

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

  // Своих пустых состояний здесь нет: «пусто», «индексирование», «ошибка» и
  // «никого нет» выбирает сам `Popup` по снимку (2.8). До первого снимка окно
  // не рисует ничего — выдумывать пятый экран на «данных ещё не приехало»
  // значило бы показать состояние приложения вместо состояния агентов.
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
