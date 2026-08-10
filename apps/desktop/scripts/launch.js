/**
 * Запуск Electron с вычищенной средой.
 *
 * В окружении разработчика бывает выставлена `ELECTRON_RUN_AS_NODE=1` — её
 * наследуют терминалы внутри VS Code и агенты, живущие в них. Под ней бинарник
 * Electron стартует обычной нодой: `require('electron')` отдаёт строку с путём,
 * `app` равен `undefined`, окна нет. Опаснее другое: если так запустить смоук,
 * он спокойно соберёт снимок через `node:sqlite` и выйдет нулём, «доказав»
 * работу Electron, которого не было.
 *
 * Поэтому единственное место запуска — здесь, и переменная снимается явно.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = fileURLToPath(new URL('../', import.meta.url))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})
