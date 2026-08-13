/**
 * Владелец сессии на живых процессах (7.6).
 *
 *     node --experimental-strip-types scripts/probe/owner-live.ts
 *
 * Четыре проверки. Всё, что здесь меряется, из фикстуры не берётся: дерево
 * процессов у каждого своё, и единственный способ узнать, что цепочка `ppid`
 * доходит до бандла, — пройти её на живой машине.
 *
 * Проба зелёная и на машине без единой сессии Claude: «сессий нет» — это не
 * поломка, а отсутствие данных, и молчаливый провал здесь врал бы про работу.
 * На Windows и Linux владельцев не бывает вовсе (`ownerApps` там пуст) — и это
 * тоже проверяется, а не подразумевается.
 */
import { execFileSync } from 'node:child_process'
import { listLiveSessions } from '../../packages/core/src/index.ts'
import { ownerApps, parseProcessTable, resolveOwners } from '../../packages/core/src/live/process.ts'

let failed = false
const sessions = listLiveSessions()
const owners = ownerApps(sessions.map((session) => session.pid))
const mac = process.platform === 'darwin'

console.log(`живых сессий Claude: ${sessions.length}, платформа: ${process.platform}`)
for (const session of sessions) {
  const owner = owners.get(session.pid)
  console.log(
    `  ${session.pid} ${session.entrypoint.padEnd(9)} ${owner?.name ?? '—'}  ${session.cwd}`,
  )
}

/**
 * Ловит цепочку, которая никуда не приходит. У сессии в VS Code, Cursor или
 * JetBrains владелец есть всегда: агент запущен расширением, расширение живёт
 * внутри приложения. Ноль владельцев при живых сессиях в редакторе означает,
 * что обход сломан, — и в продукте это молча превратится в «клик открывает
 * наше окно вместо редактора».
 */
const inEditor = sessions.filter((session) => session.entrypoint !== 'cli')
const resolved = inEditor.filter((session) => owners.has(session.pid))
report(
  1,
  'у сессий из редактора владелец найден',
  inEditor.length === 0
    ? 'сессий в редакторе нет — проверять нечего'
    : `${resolved.length} из ${inEditor.length}`,
  !mac || inEditor.length === 0 || resolved.length === inEditor.length,
)

/**
 * Ловит бандл хелпера вместо бандла приложения. Процессы расширений лежат
 * внутри `Contents/Frameworks/*.app`, и владелец с именем вроде «Cursor Helper
 * (Plugin)» в `open -a` не открывается ничем.
 */
const helpers = [...owners.values()].filter(
  (owner) => owner.bundle.includes('/Contents/') || / Helper/.test(owner.name),
)
report(
  2,
  'владелец — приложение, а не его хелпер',
  helpers.length === 0
    ? [...new Set([...owners.values()].map((owner) => owner.name))].join(', ') || 'владельцев нет'
    : helpers.map((owner) => owner.bundle).join(', '),
  helpers.length === 0,
)

/**
 * Ловит бандл, которого нет на диске. Путь идёт прямо в `open -a`, и
 * несуществующий бандл — это клик, не открывающий ничего.
 */
const missing = [...owners.values()].filter((owner) => {
  try {
    execFileSync('/usr/bin/mdls', ['-name', 'kMDItemKind', owner.bundle], { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
})
report(
  3,
  'бандл владельца существует',
  missing.length === 0 ? `проверено ${owners.size}` : missing.map((o) => o.bundle).join(', '),
  !mac || missing.length === 0,
)

/**
 * Ловит обход, который «нашёл» владельца на пустом месте. Себе самому проба
 * владельцем не является: `node` из терминала живёт вне бандла — а если
 * запущена из-под редактора, то владелец у неё тот же, что у его сессий.
 */
const table = parseProcessTable(
  mac ? execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], { encoding: 'utf8' }) : '',
)
const fake = resolveOwners(table, [Number.MAX_SAFE_INTEGER])
report(4, 'несуществующий pid владельца не даёт', `записей: ${fake.size}`, fake.size === 0)

process.exit(failed ? 1 : 0)

function report(index: number, name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${index}. ${name}: ${detail}`)
  if (!ok) failed = true
}
