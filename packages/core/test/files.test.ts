import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedFiles, ingestFile, parseRolloutFile, parseSessionFile } from '../src/index.ts'
import { claudeToolFiles, codexToolFiles } from '../src/sources/files.ts'
import { openDb, type Db } from '../src/index/db.ts'

// Пути инструментов (3.4). Разбор входа, дорога до индекса и запрос под
// карточку задачи. Каждая проверка названа поломкой, которую ловит.

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-files-'))
  db = openDb(join(dir, 'index.sqlite')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('разбор входа инструмента до пути', () => {
  // Ловит: путь взят не из того ключа, действие перепутано местами.
  it('берёт путь у инструментов с объявленным параметром', () => {
    expect(claudeToolFiles('Read', { file_path: '/proj/a.ts', limit: 20 })).toEqual([
      { path: '/proj/a.ts', action: 'read' },
    ])
    expect(claudeToolFiles('Edit', { file_path: '/proj/a.ts' })).toEqual([
      { path: '/proj/a.ts', action: 'write' },
    ])
    expect(claudeToolFiles('Write', { file_path: '/proj/a.ts' })).toEqual([
      { path: '/proj/a.ts', action: 'write' },
    ])
    expect(claudeToolFiles('NotebookEdit', { notebook_path: '/proj/a.ipynb' })).toEqual([
      { path: '/proj/a.ipynb', action: 'write' },
    ])
  })

  /**
   * Ловит соблазн «где есть похожее на путь, там и файл».
   *
   * `Bash` носит путь в командной строке у 6284 вызовов из 8778, и вытащить
   * его оттуда можно только угадыванием. `Grep` и `Glob` объявляют `path`
   * честно, но это корень поиска, почти всегда каталог.
   */
  it('молчит там, где путь пришлось бы угадывать', () => {
    expect(claudeToolFiles('Bash', { command: 'sed -n 1,40p src/app.ts' })).toBeUndefined()
    expect(claudeToolFiles('Grep', { pattern: 'x', path: '/proj/src' })).toBeUndefined()
    expect(claudeToolFiles('Glob', { pattern: '**/*.ts', path: '/proj' })).toBeUndefined()
    expect(
      claudeToolFiles('mcp__serena__replace_content', { relative_path: 'a.php' }),
    ).toBeUndefined()
  })

  // Ловит падение и выдумку на обрезанном входе: в логах у 2 вызовов `Read`
  // из 2161 вместо входа лежит `__unparsedToolInput`.
  it('переживает вход без пути и вход не объектом', () => {
    expect(claudeToolFiles('Read', { __unparsedToolInput: '…' })).toBeUndefined()
    expect(claudeToolFiles('Read', { file_path: '' })).toBeUndefined()
    expect(claudeToolFiles('Read', undefined)).toBeUndefined()
    expect(claudeToolFiles('Read', 'строка')).toBeUndefined()
  })

  /**
   * Ловит патч, сведённый к первому файлу.
   *
   * Один `apply_patch` правит сколько угодно файлов, и взять из него один путь
   * значит потерять остальные молча — счёт «затронуто N файлов» занизится, а
   * выглядеть будет как обычная цифра.
   */
  it('достаёт из патча Codex все файлы, включая переименование', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /proj/src/a.ts',
      '@@',
      '-один',
      '+два',
      '*** Add File: /proj/src/b.ts',
      '+три',
      '*** Update File: /proj/src/old.ts',
      '*** Move to: /proj/src/new.ts',
      '*** Delete File: /proj/src/gone.ts',
      '*** End Patch',
    ].join('\n')

    expect(codexToolFiles('apply_patch', patch)).toEqual([
      { path: '/proj/src/a.ts', action: 'write' },
      { path: '/proj/src/b.ts', action: 'write' },
      { path: '/proj/src/old.ts', action: 'write' },
      { path: '/proj/src/new.ts', action: 'write' },
      { path: '/proj/src/gone.ts', action: 'write' },
    ])
  })

  // Ловит разбор чего попало как патча: содержимое обезличенных фикстур и
  // оборванный хвост живого лога — не патч, а обычный текст.
  it('не считает патчем текст без заголовка', () => {
    expect(
      codexToolFiles('apply_patch', 'lorem ipsum\n*** Update File: /proj/a.ts'),
    ).toBeUndefined()
    expect(codexToolFiles('apply_patch', '*** Begin Patch\n*** End Patch')).toBeUndefined()
    expect(codexToolFiles('apply_patch', undefined)).toBeUndefined()
    expect(
      codexToolFiles('exec_command', '{"cmd":["sed","-n","1,40p","src/a.ts"]}'),
    ).toBeUndefined()
  })

  // Ловит `view_image`: у него вход — строка JSON, а не объект, и наивное
  // чтение ключа вернёт `undefined` на живом логе.
  it('разбирает аргументы function_call строкой JSON', () => {
    expect(codexToolFiles('view_image', '{"path":"/proj/shot.png","detail":"high"}')).toEqual([
      { path: '/proj/shot.png', action: 'read' },
    ])
    expect(codexToolFiles('view_image', 'не json')).toBeUndefined()
  })
})

describe('пути доезжают до индекса', () => {
  // Ловит обрыв дороги парсер → store → таблица: путь разобран, но в индекс не
  // положен, и карточка задачи молча остаётся пустой.
  it('кладёт файлы вызова в tool_files', () => {
    const parsed = parseSessionFile(join(claudeDir, 'images.jsonl'))
    const reads = parsed.requests.flatMap((request) =>
      request.tools.filter((tool) => tool.name === 'Read'),
    )
    expect(reads.every((tool) => tool.files?.[0]?.action === 'read')).toBe(true)

    ingestFile(db, { path: join(claudeDir, 'images.jsonl'), provider: 'claude', kind: 'session' })
    const rows = db.all<{ path: string; action: string }>(
      'SELECT path, action FROM tool_files ORDER BY path',
    )
    expect(rows).toHaveLength(new Set(reads.map((tool) => tool.files?.[0]?.path)).size)
    expect(rows.every((row) => row.action === 'read')).toBe(true)
  })

  // Ловит патч, потерявший файлы по дороге: пять путей одного вызова обязаны
  // стать пятью строками, а не одной.
  it('раскладывает один apply_patch на строку в файле', () => {
    const parsed = parseRolloutFile(join(codexDir, 'rollout.jsonl'))
    const patch = parsed.requests
      .flatMap((request) => request.tools)
      .find((tool) => tool.name === 'apply_patch')
    expect(patch?.files).toHaveLength(5)

    ingestFile(db, { path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
    const rows = db.all<{ path: string }>(
      "SELECT path FROM tool_files WHERE action = 'write' ORDER BY path",
    )
    expect(rows).toHaveLength(5)
  })

  // Ловит забытый каскад: файлы пережили снос своей сессии и попали бы в чужой
  // счёт после перечитывания.
  it('снимает файлы вместе с сессией', () => {
    ingestFile(db, { path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
    const before = db.get<{ n: number }>('SELECT count(*) AS n FROM tool_files')?.n ?? 0
    expect(before).toBeGreaterThan(0)

    db.run('DELETE FROM sessions')
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM tool_files')?.n).toBe(0)
  })
})

describe('затронутые файлы задачи', () => {
  /**
   * Ловит список, собранный из чтения.
   *
   * У Codex чтение идёт шеллом и в лог структурой не попадает вовсе, поэтому
   * одинаково значит у обоих провайдеров только `write`. Возьми запрос ещё и
   * `read` — и один и тот же список у Claude означал бы «прочитано и
   * изменено», а у Codex «изменено».
   */
  it('показывает изменённые файлы и не показывает прочитанные', () => {
    ingestFile(db, { path: join(claudeDir, 'images.jsonl'), provider: 'claude', kind: 'session' })
    ingestFile(db, { path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
    const claudeSession = sessionId('claude')
    const codexSession = sessionId('codex')

    expect(changedFiles(db, claudeSession)).toEqual([])
    expect(changedFiles(db, codexSession).map((file) => file.path)).toEqual([
      // Внешний путь остаётся как в логе, укороченный пишется разделителем той
      // системы, на которой считали, — отсюда `join` вместо зашитой косой.
      '/proj/shared/config.yaml',
      join('src', 'handlers.ts'),
      join('src', 'history.ts'),
      join('src', 'legacy.ts'),
      join('src', 'retry.ts'),
    ])
  })

  /**
   * Ловит путь, показанный целиком там, где виден проект, и укороченный там,
   * где файл лежит снаружи: `../../..` читается хуже абсолютного пути.
   */
  it('режет путь по каталогу сессии, а внешний оставляет как в логе', () => {
    ingestFile(db, { path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
    const files = changedFiles(db, sessionId('codex'))

    expect(files.find((file) => file.path.endsWith('handlers.ts'))?.path).toBe(
      join('src', 'handlers.ts'),
    )
    expect(files.some((file) => file.path === '/proj/shared/config.yaml')).toBe(true)
  })

  // Ловит порядок «как достала база»: чаще правленный файл обязан быть выше, а
  // при равенстве порядок обязан быть устойчивым, иначе список прыгает между
  // открытиями карточки.
  it('сортирует по числу правок, при равенстве по пути', () => {
    seedWrites([
      ['/proj/one.ts', 1],
      ['/proj/two.ts', 3],
      ['/proj/a-three.ts', 1],
    ])

    expect(changedFiles(db, 'seed')).toEqual([
      { path: 'two.ts', changes: 3 },
      { path: 'a-three.ts', changes: 1 },
      { path: 'one.ts', changes: 1 },
    ])
  })

  /**
   * Ловит оба конца счёта правок: путь, названный дважды **внутри одного**
   * вызова (патч с `Update File` и `Move to` обратно), — это одна правка, а тот
   * же путь из **двух разных** вызовов — две.
   */
  it('считает правки по вызовам, а не по строкам таблицы', () => {
    seedWrites([['/proj/one.ts', 2]])
    db.run(
      `INSERT OR IGNORE INTO tool_files (session_id, seq, idx, path, action)
       VALUES ('seed', 0, 0, '/proj/one.ts', 'write')`,
    )

    expect(changedFiles(db, 'seed')).toEqual([{ path: 'one.ts', changes: 2 }])
  })
})

function sessionId(provider: 'claude' | 'codex'): string {
  const row = db.get<{ id: string }>('SELECT id FROM sessions WHERE provider = ?', provider)
  expect(row).toBeDefined()
  return row!.id
}

/** Строки правок вручную: нужен голый порядок, а не разбор лога. */
function seedWrites(files: Array<[string, number]>): void {
  db.run(
    `INSERT INTO sessions (id, provider, source_path, cwd, project, started_at, ended_at)
     VALUES ('seed', 'claude', '/seed', '/proj', 'proj', 0, 0)`,
  )
  let seq = 0
  for (const [path, times] of files) {
    for (let call = 0; call < times; call += 1) {
      db.run(
        `INSERT INTO requests (session_id, seq, request_id, ts, model, input, output,
           cache_write, cache_read, context_tokens, is_sidechain, compacted, synthetic,
           interjected_bytes, origin)
         VALUES ('seed', ?, ?, 0, 'm', 0, 0, 0, 0, 0, 0, 0, 0, 0, 'log')`,
        seq,
        `r${seq}`,
      )
      db.run(
        `INSERT INTO tool_calls (session_id, seq, idx, tool_use_id, name, kind)
         VALUES ('seed', ?, 0, ?, 'Edit', 'builtin')`,
        seq,
        `t${seq}`,
      )
      db.run(
        `INSERT INTO tool_files (session_id, seq, idx, path, action)
         VALUES ('seed', ?, 0, ?, 'write')`,
        seq,
        path,
      )
      seq += 1
    }
  }
}
