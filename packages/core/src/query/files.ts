/**
 * Затронутые файлы задачи — блок карточки (строки 893–901 макета).
 *
 * «Затронутый» здесь значит **изменённый**, и это не выбор слова, а
 * единственная возможность: у Codex чтение идёт обычным шеллом и структурой в
 * лог не попадает вовсе, а правка едет заголовком патча. Считай мы чтение —
 * один и тот же список значил бы у Claude «прочитано и изменено», а у Codex
 * «изменено», и различить это по экрану было бы нечем. Прочитанные пути в
 * индексе лежат (`tool_files.action = 'read'`) и понадобятся, когда расход
 * начнут раскладывать по файлам; в карточке их нет.
 *
 * Порядок — по числу правок вниз, при равенстве по пути. Не по расходу:
 * стоимость измеряется у вызова, а один `apply_patch` правит несколько файлов
 * сразу, и делить его дельту между ними было бы вторым дележом поверх дележа
 * 1.6 — то есть оценкой оценки, выданной за факт.
 */
import { relative, isAbsolute } from 'node:path'
import type { Db } from '../index/db.ts'
import { taskFilter, taskSessions } from './task.ts'
import type { DayRange } from './types.ts'

export interface ChangedFile {
  /**
   * Путь относительно каталога сессии, если файл внутри него, иначе как в логе.
   *
   * Приведение живёт здесь, а не в индексе: правило показа поменяется скорее,
   * чем логи, а переиндексация ради оформления — это перечитывание всех логов.
   */
  path: string
  /** Сколько вызовов инструментов этот файл меняли. */
  changes: number
}

interface FileRow {
  path: string
  changes: number
}

/**
 * `sessionId` — корень задачи, а не одна сессия: правки сабагента сделаны в том
 * же дереве и в шапке уже посчитаны. `range` сужает до куска задачи, попавшего
 * в период ленты, — тот же довод, что у `taskDetail`.
 */
export function changedFiles(db: Db, sessionId: string, range?: DayRange): ChangedFile[] {
  const cwd = db.get<{ cwd: string }>('SELECT cwd FROM sessions WHERE id = ?', sessionId)?.cwd
  const filter = taskFilter(taskSessions(db, sessionId), range)
  const rows = db.all<FileRow>(
    `SELECT tool_files.path AS path, count(*) AS changes
       FROM tool_files
       JOIN requests ON requests.session_id = tool_files.session_id
                    AND requests.seq = tool_files.seq
      WHERE ${filter.sql} AND tool_files.action = 'write'
      GROUP BY tool_files.path`,
    ...filter.params,
  )
  // Порядок берётся по показанному пути, а не по тому, что лежит в базе: иначе
  // список, укороченный по каталогу проекта, выглядит неотсортированным —
  // `/proj/h/lorem/src/a.ts` и `src/a.ts` стоят в алфавите в разных местах.
  return rows
    .map((row) => ({ path: display(row.path, cwd), changes: row.changes }))
    .sort((left, right) => right.changes - left.changes || left.path.localeCompare(right.path))
}

/**
 * Внутри проекта — короткий путь, снаружи — как в логе.
 *
 * Наружу вылезает не абстракция: правка в `~/.claude/skills/…` относительно
 * проекта выглядит как `../../../.claude/skills/…`, и это хуже абсолютного
 * пути, а не лучше. Признак «снаружи» — точки в начале, а не сравнение строк:
 * `/Users/fost/Projects/agentmeter-old` начинается с `/Users/fost/Projects/agentmeter`.
 */
export function display(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0 || !isAbsolute(path)) return path
  const short = relative(cwd, path)
  return short.length === 0 || short.startsWith('..') ? path : short
}
