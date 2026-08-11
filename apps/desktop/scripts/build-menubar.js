// Сборка нативного значка в menu bar (macOS).
//
// Почему он вообще есть — в шапке `src/main/menubar.ts`: на macOS 26 пункт от
// Electron 43 в панель не встаёт. Здесь только компиляция.
//
// Собирается **универсальным**: приложение едет двумя dmg, arm64 и x64, а
// хелпер лежит в ресурсах одним файлом на обе сборки. Соберись он под свою
// машину — на второй архитектуре получился бы значок, который не запускается, и
// узналось бы это у пользователя, а не в упаковке.
//
// На чужой платформе скрипт молча и успешно ничего не делает: `npm run build`
// зовут и на Windows с Linux, где значок рисует `Tray` и хелпер не нужен вовсе.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'menubar', 'AgentmeterBar.swift')
const out = join(root, 'menubar', 'build')
const binary = join(out, 'agentmeter-menubar')

/** Минимальная macOS. Ниже 11 нет arm64, а выше отрезало бы живые машины. */
const TARGETS = [
  { arch: 'arm64', triple: 'arm64-apple-macos11' },
  { arch: 'x86_64', triple: 'x86_64-apple-macos11' },
]

if (process.platform !== 'darwin') {
  console.log('значок menu bar: не macOS, пропускаю')
  process.exit(0)
}

mkdirSync(out, { recursive: true })

const slices = TARGETS.map(({ arch, triple }) => {
  const slice = join(out, `agentmeter-menubar-${arch}`)
  execFileSync('swiftc', ['-O', '-target', triple, '-o', slice, source], { stdio: 'inherit' })
  return slice
})

execFileSync('lipo', ['-create', '-output', binary, ...slices], { stdio: 'inherit' })
for (const slice of slices) rmSync(slice, { force: true })

const arches = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim()
console.log(`значок menu bar собран: ${binary} (${arches})`)
