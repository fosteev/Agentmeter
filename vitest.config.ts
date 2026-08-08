import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url))

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
        resolve: { alias: { '@agentmeter/core': coreSrc } },
        test: {
          name: 'cli',
          root: './apps/cli',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
})
