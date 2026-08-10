import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Бандлер — только для рендерера. Main собирается обычным `tsc` и остаётся
 * обычным Node-кодом: иначе `node:sqlite` и пути к домашним каталогам придётся
 * чинить настройками сборки.
 *
 * Выход — статические файлы, окно грузит их с `file://`, поэтому `base: './'`:
 * с абсолютными путями страница из файла не найдёт ни скриптов, ни шрифтов.
 */

const renderer = fileURLToPath(new URL('./src/renderer', import.meta.url))
const formatter = fileURLToPath(
  new URL('../../packages/core/src/format/tokens.ts', import.meta.url),
)

export default defineConfig({
  root: renderer,
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      // Форматтер берётся исходником, минуя `index.ts` ядра: барель тянет
      // `node:sqlite`, и в браузерном бандле он либо роняет сборку, либо
      // приезжает мёртвым грузом.
      { find: '@agentmeter/core/format', replacement: formatter },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    // Витрина 2.4 — вторая точка входа и не выбрасывается: это спецификация
    // компонентов, на которую после этого этапа наконец можно смотреть.
    rollupOptions: {
      input: {
        index: `${renderer}/index.html`,
        gallery: `${renderer}/gallery.html`,
      },
    },
  },
})
