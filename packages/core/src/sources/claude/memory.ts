/**
 * Файлы памяти, которые едут в промпт, но в логе не названы (долг 1.7 → 4.1).
 *
 * Записи `nested_memory` перечисляют только **вложенные проектные** `CLAUDE.md`:
 * проверено по всем транскриптам — 117 упоминаний, все до одного из
 * `~/Projects/**`. Глобального `~/.claude/CLAUDE.md` среди них нет ни разу, хотя
 * в промпте он есть в каждой сессии (2395 байт, около 580 токенов), и рядом с
 * ним индекс автопамяти `projects/<slug>/memory/MEMORY.md`. Оба оседали в
 * остатке `system`, то есть удаляемый пользователем текст числился неудаляемым —
 * ровно та ошибка, на которой совет 4.3 оказался бы про то, что выключить нельзя.
 *
 * Пути собираются здесь, а не в парсере: парсер, залезающий в домашний каталог,
 * делает тесты машинозависимыми. Ему список приезжает параметром, и пустой
 * список — это в точности поведение до 4.1.
 */
import { join, resolve, sep } from 'node:path'

/**
 * Что дочитать к префиксу сессии Claude, лежащей в `sourcePath`.
 *
 * Существование файлов здесь не проверяется намеренно: проверка — это обращение
 * к диску, а вызывающий (`ingest`) и так читает их содержимое и молча
 * пропускает отсутствующие. Две проверки на один файл — это гонка, в которой
 * между ними файл успевает исчезнуть.
 */
export function claudeMemoryPaths(sourcePath: string, claudeHome: string): string[] {
  const paths = [resolve(claudeHome, 'CLAUDE.md')]
  const projectDir = claudeProjectDir(resolve(sourcePath), resolve(claudeHome))
  if (projectDir !== undefined) paths.push(join(projectDir, 'memory', 'MEMORY.md'))
  return paths
}

/**
 * Каталог проекта (`<claudeHome>/projects/<slug>`) по пути транскрипта.
 *
 * Сабагент лежит глубже (`<slug>/<sessionId>/subagents/agent-*.jsonl`), а у
 * воркфлоу — ещё на уровень ниже, поэтому берётся не «родитель файла», а
 * **первый** сегмент после `projects`. `undefined` — файл лежит не под этим
 * домом вовсе: у нестандартного каталога из `sources.extra` каталога проектов
 * может не быть, и придумывать ему путь значит приписать сессии чужую память.
 */
function claudeProjectDir(sourcePath: string, claudeHome: string): string | undefined {
  const root = join(claudeHome, 'projects') + sep
  if (!sourcePath.startsWith(root)) return undefined
  const slug = sourcePath.slice(root.length).split(sep)[0]
  return slug === undefined || slug === '' ? undefined : join(root, slug)
}
