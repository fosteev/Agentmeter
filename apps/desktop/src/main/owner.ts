/**
 * Какое приложение открыть по клику на уведомлении (7.6).
 *
 * Уведомление «Claude закончил — Agentmeter» отвечает на вопрос «пора
 * вернуться», и возвращаться человек хочет **в свой редактор**, а не в счётчик
 * токенов. Отсюда весь модуль: связать сессию из уведомления с программой, в
 * которой она живёт, и поднять именно её.
 *
 * ## Три правила, на которых всё держится
 *
 * **Первое: программа измеряется, а не угадывается.** В файле сессии лежит
 * `entrypoint`, и у VS Code, Cursor и Windsurf он одинаковый — `claude-vscode`.
 * Открывать по нему VS Code означало бы у половины людей открывать не то.
 * Настоящее приложение даёт цепочка `ppid` от процесса агента вверх до бандла
 * (`ownerApps` в ядре), и это факт, а не догадка.
 *
 * **Второе: узнавать надо, пока агент жив.** `done` в снимке означает, что
 * процесса уже нет (`live/state.ts`), — то есть в момент самого интересного
 * уведомления спрашивать `ps` поздно. Поэтому владелец запоминается, как только
 * сессия впервые появилась в снимке, и переживает её смерть.
 *
 * **Третье: не узнали — открываем своё окно, а не похожее.** У Codex реестра
 * процессов нет вовсе (пункт 9 в `CLAUDE.md`), на Windows и Linux цепочка не
 * читается, и в обоих случаях `lookup` отвечает «нет». Открыть «наверное, это
 * был VS Code» хуже, чем не открыть ничего: уведомление, иногда поднимающее
 * чужое окно, перестают трогать вовсе.
 *
 * Хранится это в памяти процесса и умирает вместе с ним — как и журнал
 * показанных поводов в `notify.ts`: после перезапуска первое уведомление всё
 * равно не показывается, и переживать себя этой памяти незачем.
 */
import { execFile } from 'node:child_process'
import { listLiveSessions, ownerApps, type LiveSession, type OwnerApp } from '@agentmeter/core'

export interface OwnerDeps {
  /** Реестр живых сессий. Подменяется в тестах, где реестра на диске нет. */
  sessions?: () => readonly LiveSession[]
  owners?: (pids: readonly number[]) => Map<number, OwnerApp>
  /** Поднять приложение. Отказ — исключение, и он доезжает до вызвавшего. */
  activate?: (bundle: string) => Promise<void>
}

export interface OwnerBook {
  /**
   * Запомнить владельцев сессий, которых ещё не знаем.
   *
   * Зовётся на каждом опросе трея, поэтому первым делом отсекает известные:
   * когда новых сессий нет — ни чтения реестра, ни `ps`. Без этого раз в
   * секунду читался бы каталог и запускался процесс ради неизменного ответа.
   */
  learn(sessionIds: readonly string[]): void
  /** `undefined` — не знаем такой сессии или знаем, что владельца нет. */
  lookup(sessionId: string | undefined): OwnerApp | undefined
  /** Поднять программу сессии. `false` — не вышло, зовущий открывает своё окно. */
  reveal(sessionId: string | undefined): Promise<boolean>
}

/**
 * Сколько сессий помним. Ограничение не про память (запись — две строки), а
 * про то, что множество без потолка растёт весь сеанс: на машине с десятком
 * чатов в день это тысячи записей о программах, давно закрытых.
 */
const REMEMBER = 200

export function createOwnerBook(deps: OwnerDeps = {}): OwnerBook {
  const sessions = deps.sessions ?? (() => listLiveSessions())
  const owners = deps.owners ?? ownerApps
  const activate = deps.activate ?? openBundle
  /** `null` — спрашивали и не узнали. Второй раз не спрашиваем. */
  const known = new Map<string, OwnerApp | null>()

  const learn = (sessionIds: readonly string[]): void => {
    const fresh = [...new Set(sessionIds)].filter((id) => !known.has(id))
    if (fresh.length === 0) return

    const pids = new Map<string, number>()
    // Реестр читается здесь, а не берётся из снимка: pid — деталь процесса, и
    // тащить его через контракт main↔renderer ради одного клика значило бы
    // добавить в него поле, которое окну не нужно.
    for (const session of sessions()) pids.set(session.sessionId, session.pid)
    const found = owners(fresh.map((id) => pids.get(id)).filter(isPid))

    for (const id of fresh) {
      const pid = pids.get(id)
      known.set(id, (pid === undefined ? undefined : found.get(pid)) ?? null)
    }
    forget()
  }

  const forget = (): void => {
    // `Map` держит порядок вставки, поэтому «самая старая» — просто первая.
    for (const id of known.keys()) {
      if (known.size <= REMEMBER) break
      known.delete(id)
    }
  }

  const lookup = (sessionId: string | undefined): OwnerApp | undefined =>
    sessionId === undefined ? undefined : (known.get(sessionId) ?? undefined)

  const reveal = async (sessionId: string | undefined): Promise<boolean> => {
    const owner = lookup(sessionId)
    if (owner === undefined) return false
    try {
      await activate(owner.bundle)
      return true
    } catch {
      // Приложение снесли или переименовали. Молчать нельзя — клик обязан
      // хоть куда-то привести, и зовущий откроет своё окно.
      return false
    }
  }

  return { learn, lookup, reveal }
}

function isPid(value: number | undefined): value is number {
  return value !== undefined
}

/**
 * Поднять бандл через `open`.
 *
 * Не `NSRunningApplication` по pid из нашего хелпера в menu bar и не
 * AppleScript: первое привязало бы клик к жизни постороннего процесса и к тому
 * же pid (а приложение за день перезапускают), второе требует разрешения
 * «Автоматизация», которого у неподписанной сборки не будет. `open -a` не
 * просит ничего и работает с путём, который переживает перезапуск.
 */
function openBundle(bundle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', bundle], (error) => (error ? reject(error) : resolve()))
  })
}
