/**
 * Автообновление (5.4) — состояние отдельно от механики.
 *
 * Здесь только правила: что показывать, когда можно идти в сеть и во что
 * превращается очередное событие загрузчика. Сам `electron-updater` живёт в
 * `index.ts` и в эти функции не заглядывает — иначе проверить их можно было бы
 * только настоящим релизом на GitHub.
 *
 * **Это единственный сетевой вызов продукта.** Всё остальное Agentmeter читает
 * с диска, и обещание «никаких сетевых вызовов» в README оговаривает ровно эту
 * проверку. Отсюда два правила, которые нельзя ослаблять: настройка выключает
 * её целиком (а не «спрашивает, но не скачивает»), и в неустановленном
 * приложении её нет вовсе.
 */

export type UpdatePhase =
  | 'unsupported'
  | 'off'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** Версия, которая работает прямо сейчас. Есть всегда — её показывают и в покое. */
  current: string
  /** Найденная версия. Есть с момента находки и до установки. */
  version?: string
  /** Процент скачанного, 0…100. Только в `downloading`. */
  percent?: number
  /** Что сломалось. Только в `error` — текст от загрузчика, не наш пересказ. */
  error?: string
}

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'none' }
  | { type: 'found'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }

export function initialUpdateState(current: string, packaged: boolean, auto: boolean): UpdateState {
  if (!packaged) return { phase: 'unsupported', current }
  return { phase: auto ? 'idle' : 'off', current }
}

/**
 * Следующее состояние.
 *
 * Главное правило здесь одно, и оно про кнопку: **скачанное обновление не
 * отменяется ничем, кроме установки.** Проверка идёт по таймеру, и без этого
 * правила очередная проверка через час стирала бы `ready` — кнопка «Установить
 * и перезапустить» исчезала бы у человека из-под курсора, а приложение
 * выглядело бы исправным. По той же причине `ready` переживает ошибку сети:
 * файл уже на диске, и сеть ему больше не нужна.
 */
export function nextUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  if (state.phase === 'unsupported' || state.phase === 'off') return state
  if (state.phase === 'ready' && event.type !== 'ready') return state
  switch (event.type) {
    case 'check':
      return { phase: 'checking', current: state.current }
    case 'none':
      return { phase: 'idle', current: state.current }
    case 'found':
      return { phase: 'downloading', current: state.current, version: event.version, percent: 0 }
    case 'progress':
      return {
        phase: 'downloading',
        current: state.current,
        ...(state.version === undefined ? {} : { version: state.version }),
        percent: Math.max(0, Math.min(100, Math.round(event.percent))),
      }
    case 'ready':
      return { phase: 'ready', current: state.current, version: event.version }
    case 'error':
      return { phase: 'error', current: state.current, error: event.message }
  }
}

/**
 * Можно ли идти в сеть.
 *
 * Спрашивается **перед каждой** проверкой, а не один раз при запуске: настройку
 * выключают на ходу, и таймер, заведённый раньше, обязан замолчать сразу.
 * Проверка во время скачивания не нужна тем более — вторая загрузка того же
 * файла не ускорит первую.
 */
export function mayCheck(state: UpdateState, auto: boolean, manual = false): boolean {
  if (state.phase === 'unsupported') return false
  if (!auto && !manual) return false
  return state.phase !== 'checking' && state.phase !== 'downloading' && state.phase !== 'ready'
}

/** Как настройка меняет состояние: выключили — молчим, включили — снова покой. */
export function applyAuto(state: UpdateState, auto: boolean): UpdateState {
  if (state.phase === 'unsupported') return state
  if (!auto) return { phase: 'off', current: state.current }
  return state.phase === 'off' ? { phase: 'idle', current: state.current } : state
}
