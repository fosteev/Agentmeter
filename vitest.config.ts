import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url))
const coreFormat = fileURLToPath(new URL('./packages/core/src/format/tokens.ts', import.meta.url))
const coreDay = fileURLToPath(new URL('./packages/core/src/query/day.ts', import.meta.url))
const coreI18n = fileURLToPath(new URL('./packages/core/src/i18n/index.ts', import.meta.url))
const ipcSrc = fileURLToPath(new URL('./packages/ipc/src/index.ts', import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        // CLI ходит в ядро через имя пакета, но тесты не должны ждать сборки —
        // алиас уводит импорт на исходники.
        resolve: {
          alias: [
            { find: '@agentmeter/core/i18n', replacement: coreI18n },
            { find: '@agentmeter/core', replacement: coreSrc },
          ],
        },
        test: {
          name: 'cli',
          root: './apps/cli',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ipc',
          root: './packages/ipc',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        // Рендерер ходит в ядро только за форматтером, и берёт его подпутём:
        // барель тянет `node:sqlite`, которому в окне делать нечего. Алиасы
        // уводят оба импорта на исходники, чтобы тесты не ждали сборки.
        resolve: {
          alias: [
            { find: '@agentmeter/core/format', replacement: coreFormat },
            { find: '@agentmeter/core/day', replacement: coreDay },
            { find: '@agentmeter/core/i18n', replacement: coreI18n },
            { find: '@agentmeter/core', replacement: coreSrc },
            { find: '@agentmeter/ipc', replacement: ipcSrc },
          ],
        },
        test: {
          name: 'desktop',
          root: './apps/desktop',
          include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        },
      },
    ],
  },
})
