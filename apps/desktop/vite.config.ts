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
const day = fileURLToPath(new URL('../../packages/core/src/query/day.ts', import.meta.url))

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
      // Границы дня — то же самое: правило одно на CLI, трей и окно, а
      // `query/day.ts` ни к базе, ни к файловой системе не ходит.
      { find: '@agentmeter/core/day', replacement: day },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    // Витрина и главное окно — отдельные страницы того же рендерера.
    rollupOptions: {
      input: {
        index: `${renderer}/index.html`,
        gallery: `${renderer}/gallery.html`,
        window: `${renderer}/window.html`,
      },
    },
  },
})
