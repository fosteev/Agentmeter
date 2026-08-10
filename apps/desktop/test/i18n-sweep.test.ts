import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Ни одной строки интерфейса в коде (3.8) — проверкой, а не обещанием.
 *
 * Критерий этапа звучит абсолютно, и проверять его глазами бессмысленно: новая
 * строка пишется в коде за секунду, а ищется потом руками по всему репозиторию.
 * Здесь она находится сразу — кириллица в строковом литерале продуктового кода
 * значит, что текст не доехал до каталога.
 *
 * Исключения названы поимённо и объяснены. Список закрытый: дописывать в него
 * можно только вместе с доводом, почему эта строка **не** интерфейс.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Что не переводится и почему.
 *
 * `gallery.tsx` — витрина компонентов: инструмент верстальщика, в приложение не
 * попадает вовсе (отдельная страница, открывается командой `gallery`). Её
 * подписи — это названия токенов макета для того, кто сверяет вёрстку, а не
 * текст продукта.
 *
 * `main/index.ts` — диагностика смоука: строки уезжают в JSON, который читает
 * проба, а не человек. Переведи их — и проба начнёт зависеть от языка машины,
 * на которой её запустили.
 */
const NOT_INTERFACE = new Set([
  'apps/desktop/src/renderer/gallery.tsx',
  'apps/desktop/src/main/index.ts',
])

const AREAS = ['apps/desktop/src/renderer', 'apps/desktop/src/main', 'apps/cli/src']

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const relative = `${dir}/${name}`
    if (statSync(join(root, relative)).isDirectory()) return sources(relative)
    return /\.tsx?$/.test(name) ? [relative] : []
  })
}

/** Комментарии — не интерфейс: они на русском и останутся на нём. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function literals(source: string): string[] {
  const found: string[] = []
  for (const match of withoutComments(source).matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    if (/[А-Яа-яЁё]/.test(match[2]!)) found.push(match[2]!.replace(/\s+/g, ' ').slice(0, 80))
  }
  return found
}

describe('строки интерфейса', () => {
  /**
   * Ловит текст, написанный мимо каталога. Один такой литерал — это одно место,
   * которое на английском останется русским, и заметит его пользователь, а не
   * сборка.
   */
  it('в продуктовом коде окна, трея и CLI нет русских литералов', () => {
    const offenders: string[] = []
    for (const area of AREAS) {
      for (const file of sources(area)) {
        if (NOT_INTERFACE.has(file)) continue
        for (const value of literals(readFileSync(join(root, file), 'utf8'))) {
          offenders.push(`${file}: «${value}»`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * Ловит исключение, оставшееся от удалённого файла: список закрытый, и
   * мёртвая строка в нём однажды прикроет живой файл с тем же именем.
   */
  it('каждое исключение указывает на существующий файл', () => {
    for (const file of NOT_INTERFACE) {
      expect(() => statSync(join(root, file)), file).not.toThrow()
    }
  })
})
