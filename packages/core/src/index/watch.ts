import { existsSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { DiscoverOpts } from './discover.ts'
import { defaultClaudeHome, defaultCodexHome } from './paths.ts'
import { ingestAll, type IngestOptions, type IngestStats } from './ingest.ts'
import type { Db } from './db.ts'

export interface Watcher {
  close(): void
}

export function watchSources(
  db: Db,
  // Не `DiscoverOpts`: вотчер зовёт тот же `ingestAll`, а тот пересобирает окна
  // лимита. Потеряй он здесь `claudeLimits` — первое же изменение файла молча
  // заменило бы посчитанный процент Claude на «неизвестно», и в трее он просто
  // исчез бы после сохранения любого лога.
  opts: IngestOptions & {
    debounceMs?: number
    rediscoverMs?: number
    onBatch?: (paths: string[], stats: IngestStats) => void
  } = {},
): Watcher {
  const debounceMs = opts.debounceMs ?? 300
  const rediscoverMs = opts.rediscoverMs ?? 30_000
  const pending = new Set<string>()
  const watchers: FSWatcher[] = []
  const timers: NodeJS.Timeout[] = []
  let debounce: NodeJS.Timeout | undefined
  let closed = false

  const flush = (paths: string[]) => {
    if (closed) return
    try {
      const stats = ingestAll(db, opts)
      opts.onBatch?.(paths, stats)
    } catch {
      // Вотчер не должен валить процесс. Ошибка конкретного файла попадёт в
      // diagnostics через ingest; ошибки окружения попробуем пережить на новом событии.
    }
  }

  const schedule = (path: string) => {
    pending.add(path)
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      const paths = [...pending].sort()
      pending.clear()
      flush(paths)
    }, debounceMs)
  }

  for (const root of watchRoots(opts)) {
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        schedule(filename ? join(root, filename.toString()) : root)
      })
      watcher.on('error', () => schedule(root))
      watchers.push(watcher)
    } catch {
      timers.push(setInterval(() => flush([root]), 2_000))
    }
  }

  timers.push(setInterval(() => flush(['<rediscover>']), rediscoverMs))

  return {
    close(): void {
      closed = true
      if (debounce) clearTimeout(debounce)
      for (const watcher of watchers) watcher.close()
      for (const timer of timers) clearInterval(timer)
    },
  }
}

function watchRoots(opts: DiscoverOpts): string[] {
  const roots = [
    join(opts.claudeHome ?? defaultClaudeHome(), 'projects'),
    join(opts.codexHome ?? defaultCodexHome(), 'sessions'),
    ...(opts.extra ?? []),
  ]
  return [...new Set(roots)].filter((root) => existsSync(root) && statSync(root).isDirectory())
}
