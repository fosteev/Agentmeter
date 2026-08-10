/**
 * Снимки экранов для README (5.5) — запуск.
 *
 *     node scripts/make-shots.js
 *
 * Работа целиком в `scripts/shots/` — это отдельное приложение Electron,
 * поднимающее макет и снимающее из него экраны. Здесь только то, ради чего
 * запуск вообще выделен в файл: с `ELECTRON_RUN_AS_NODE` в среде бинарник
 * Electron стартует обычной нодой и окна не поднимает вовсе (та же ловушка,
 * что в `apps/desktop/scripts/launch.js`), а `--force-device-scale-factor=2`
 * даёт retina независимо от того, на каком мониторе снимают: снимок в один
 * пиксель на точку на странице GitHub выглядит замыленным, и заметно это
 * читателю, а не тому, кто снимал.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const shots = fileURLToPath(new URL('./shots/', import.meta.url))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['--force-device-scale-factor=2', shots], {
  stdio: 'inherit',
  env,
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
