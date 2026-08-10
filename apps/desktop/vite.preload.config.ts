import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Preload собирается отдельно и в CommonJS.
 *
 * Причина не в моде: при `sandbox: true` Electron грузит preload в
 * ограниченном контексте, где ESM не поддерживается вовсе. Отказаться от
 * песочницы ради красоты сборки нельзя — окно показывает содержимое домашних
 * каталогов пользователя.
 *
 * Списки каналов приезжают сюда из контракта и запекаются в файл: строковых
 * имён в preload нет так же, как и в рендерере.
 */

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist/preload', import.meta.url)),
    // Рядом лежит вывод `tsc` для проверки типов — стирать каталог нельзя.
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: { external: ['electron'] },
  },
})
