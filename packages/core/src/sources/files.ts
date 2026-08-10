/**
 * Какие файлы прошли через вызов инструмента (этап 3.4).
 *
 * Путь берётся **только из объявленного параметра инструмента** — `file_path` у
 * `Read`/`Edit`/`Write`, заголовки `*** Update File:` у патча Codex. Разбирать
 * командную строку `Bash` и `exec_command` мы не будем: там путь надо угадывать
 * из произвольного шелла (`cd … && sed -n '1,40p' …`, кавычки, переменные,
 * подстановки), а угаданный путь в измерительном продукте ничем не отличается
 * от выдуманного. Это видно и по логам: у `Bash` из 8778 вызовов «что-то
 * похожее на путь» есть в 6284, то есть эвристика молчала бы ровно там, где
 * ошибается.
 *
 * Отсюда же несимметричность провайдеров, и её важно понимать до того, как
 * поверить списку файлов: **у Claude видно и чтение, и запись, у Codex — только
 * запись.** Правки Codex едут структурой (`apply_patch` с заголовками файлов,
 * 1927 вызовов из 1927 — одним и тем же форматом), а чтение — обычным шеллом,
 * которого здесь нет. Поэтому «затронутый файл» в карточке задачи — это
 * **изменённый** файл: только он значит одно и то же у обоих. Прочитанные пути
 * тоже сохраняются — они понадобятся, когда расход начнут раскладывать по
 * файлам (4.x), — но в список карточки не идут.
 *
 * Чего здесь намеренно нет: MCP-инструменты. Путь у них лежит в своём ключе
 * (`relative_path` у serena), а вид действия из имени не выводится — `find_symbol`
 * читает, `replace_content` пишет, и общего правила для незнакомого сервера не
 * существует. Размер дыры измерен по всему диску: 179 вызовов MCP с путём на
 * 16 783 вызова инструментов (1.1%), из них правок 48 против 3997 у `Edit` и
 * `Write` (1.2%). Закрывается списком под конкретный сервер — тогда, когда
 * такой список будет чем проверить.
 */
import type { ToolFile } from './types.ts'

/** Инструменты Claude, у которых путь объявлен параметром. */
const CLAUDE_TOOLS: Record<string, { key: string; action: ToolFile['action'] }> = {
  Read: { key: 'file_path', action: 'read' },
  Edit: { key: 'file_path', action: 'write' },
  Write: { key: 'file_path', action: 'write' },
  // В корпусе на диске не встретился ни разу, но параметр у него объявлен так
  // же, как у соседей, и промолчать про изменённый ноутбук хуже, чем завести
  // строку в таблице.
  NotebookEdit: { key: 'notebook_path', action: 'write' },
}

/**
 * `Grep` и `Glob` сюда не входят, хотя `path` у них есть: это корень поиска,
 * почти всегда каталог. Посчитать его затронутым файлом — соврать в самом
 * заметном месте карточки.
 */
export function claudeToolFiles(name: string, input: unknown): ToolFile[] | undefined {
  const tool = CLAUDE_TOOLS[name]
  if (tool === undefined) return undefined
  const path = field(input, tool.key)
  // Вход у инструмента бывает обрезан (в логах есть `__unparsedToolInput`):
  // 2159 путей на 2161 вызов `Read`. Пустой ответ здесь — «источник промолчал»,
  // и это не повод ни падать, ни выдумывать.
  if (path === undefined) return undefined
  return [{ path, action: tool.action }]
}

/**
 * У Codex путь объявлен ровно у двух инструментов.
 *
 * `apply_patch` приезжает `custom_tool_call`, и его `input` — не JSON, а текст
 * патча целиком. Заголовки внутри — формат, а не догадка: на диске 1927 вызовов
 * из 1927 начинаются `*** Begin Patch`. Один патч трогает **несколько** файлов,
 * поэтому здесь список, а не одно значение: взять первый путь значило бы тихо
 * потерять остальные.
 */
export function codexToolFiles(name: string, raw: unknown): ToolFile[] | undefined {
  if (name === 'apply_patch') return patchFiles(raw)
  if (name === 'view_image') {
    const path = field(parseArguments(raw), 'path')
    return path === undefined ? undefined : [{ path, action: 'read' }]
  }
  return undefined
}

const PATCH_HEADER = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/

function patchFiles(raw: unknown): ToolFile[] | undefined {
  if (typeof raw !== 'string' || !raw.trimStart().startsWith('*** Begin Patch')) return undefined
  const paths: string[] = []
  for (const line of raw.split('\n')) {
    const path = PATCH_HEADER.exec(line)?.[1]
    // `Move to:` даёт новое имя рядом со старым из `Update File:` — затронуты
    // оба, и оба остаются в списке.
    if (path !== undefined && path.length > 0 && !paths.includes(path)) paths.push(path)
  }
  return paths.length === 0 ? undefined : paths.map((path) => ({ path, action: 'write' }))
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function field(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
