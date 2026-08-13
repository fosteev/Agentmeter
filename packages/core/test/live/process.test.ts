import { describe, expect, it } from 'vitest'
import { bundleOf, parseProcessTable, resolveOwners } from '../../src/live/process.ts'

/**
 * Кому принадлежит процесс агента (7.6).
 *
 * Проверяется не обход дерева как алгоритм, а два места, где ответ получается
 * правдоподобным и неверным: бандл хелпера вместо бандла приложения и обрыв
 * цепочки, который легко принять за «нашли». Клик по уведомлению, поднимающий
 * не ту программу, хуже клика, не поднимающего ничего.
 *
 * Таблица взята с живой машины: `ps -Ao pid=,ppid=,comm=`, сессия Claude в
 * Cursor — три прыжка от агента до бандла.
 */

const LIVE = [
  '28496 12103 /Users/fost/.cursor/extensions/anthropic.claude-code-2.1.227-darwin-arm64/resources/native-binary/claude',
  '12103 11691 Cursor Helper (Plugin): extension-host (user) Agentmeter [1-1]',
  '11691     1 /Applications/Cursor.app/Contents/MacOS/Cursor',
  '10322 10319 /Users/fost/Library/Caches/JetBrains/acp-agents/node_modules/claude',
  '10319 25248 node',
  '25248     1 /Users/fost/Applications/PhpStorm.app/Contents/MacOS/phpstorm',
].join('\n')

describe('parseProcessTable', () => {
  /**
   * Ловит разбор сплитом по пробелам. Заголовок процесса у хелперов Electron
   * содержит и пробелы, и скобки, и квадратные скобки: «Cursor Helper
   * (Plugin): extension-host (user) Agentmeter [1-1]».
   */
  it('имя команды с пробелами берётся целиком', () => {
    const rows = parseProcessTable(LIVE)

    expect(rows).toHaveLength(6)
    expect(rows[1]).toEqual({
      pid: 12103,
      ppid: 11691,
      command: 'Cursor Helper (Plugin): extension-host (user) Agentmeter [1-1]',
    })
  })

  it('мусорные строки пропускаются, а не роняют разбор', () => {
    expect(parseProcessTable('\nPID PPID COMM\n  17 1 /bin/zsh\n')).toEqual([
      { pid: 17, ppid: 1, command: '/bin/zsh' },
    ])
  })
})

describe('bundleOf', () => {
  it('бандл и имя из пути к исполняемому файлу', () => {
    expect(bundleOf('/Applications/Cursor.app/Contents/MacOS/Cursor')).toEqual({
      bundle: '/Applications/Cursor.app',
      name: 'Cursor',
    })
  })

  /**
   * Ловит поиск последнего `.app` в пути. Хелперы Electron лежат внутри бандла
   * своего приложения, и «ближайший» бандл у них — `Cursor Helper (Plugin).app`:
   * имени, которого нет ни в Dock, ни в `open -a`, и клик уходил бы в никуда.
   */
  it('у хелпера внутри бандла владелец — внешнее приложение', () => {
    const helper =
      '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)'

    expect(bundleOf(helper)).toEqual({ bundle: '/Applications/Cursor.app', name: 'Cursor' })
  })

  it('процесс вне бандла владельцем не считается', () => {
    expect(bundleOf('/bin/zsh')).toBeUndefined()
    expect(bundleOf('Cursor Helper (Plugin): extension-host (user) at [4-37]')).toBeUndefined()
    // Каталог с точкой `.app` в имени — не бандл: признак бандла тут только
    // `Contents/MacOS`, и без него путь остаётся обычным путём.
    expect(bundleOf('/Users/fost/my.app/bin/agent')).toBeUndefined()
  })
})

describe('resolveOwners', () => {
  it('поднимается по родителям до первого бандла', () => {
    const owners = resolveOwners(parseProcessTable(LIVE), [28496, 10322])

    expect(owners.get(28496)).toEqual({ bundle: '/Applications/Cursor.app', name: 'Cursor' })
    expect(owners.get(10322)).toEqual({
      bundle: '/Users/fost/Applications/PhpStorm.app',
      name: 'PhpStorm',
    })
  })

  /**
   * Ловит «нашли хоть что-нибудь». Процесс, чей родитель умер и подобран
   * `launchd`, до бандла не доходит — и это ответ «не знаем», а не повод
   * открыть первое попавшееся приложение.
   */
  it('оборванная цепочка владельца не даёт', () => {
    const rows = parseProcessTable('  42 1 /usr/local/bin/claude\n')

    expect(resolveOwners(rows, [42]).size).toBe(0)
    // Процесса нет в таблице вовсе — тот же ответ.
    expect(resolveOwners(rows, [777]).size).toBe(0)
  })

  /**
   * Ловит вечный цикл. `ppid` приезжает от ОС, процессы между строками таблицы
   * умирают и рождаются заново, и кольцо здесь повесило бы опрос трея намертво
   * — вместе со всем приложением.
   */
  it('кольцо в родителях не вешает обход', () => {
    const rows = parseProcessTable(['  10 11 a', '  11 10 b'].join('\n'))

    expect(resolveOwners(rows, [10]).size).toBe(0)
  })
})
