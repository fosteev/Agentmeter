import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { defaultClaudeHome, defaultCodexHome } from './paths.ts'
import type { Provider } from '../sources/types.ts'

export interface SourceFile {
  path: string
  provider: Provider
  kind: 'session' | 'subagent'
  /** Только у сабагента: файл родительской сессии. */
  parentPath?: string
}

export interface DiscoverOpts {
  claudeHome?: string
  codexHome?: string
  extra?: readonly string[]
}

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

export function discoverSources(opts: DiscoverOpts = {}): SourceFile[] {
  const found = new Map<string, SourceFile>()

  for (const file of discoverClaudeProjects(
    join(opts.claudeHome ?? defaultClaudeHome(), 'projects'),
  )) {
    found.set(file.path, file)
  }
  for (const file of discoverCodexSessions(
    join(opts.codexHome ?? defaultCodexHome(), 'sessions'),
  )) {
    found.set(file.path, file)
  }

  for (const root of opts.extra ?? []) {
    for (const file of discoverExtraRoot(root)) found.set(file.path, file)
  }

  return [...found.values()].sort(compareSources)
}

export function discoverClaudeProjects(root: string): SourceFile[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const files: SourceFile[] = []

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('-')) continue
    const projectDir = join(root, entry.name)
    for (const child of readdirSync(projectDir, { withFileTypes: true })) {
      if (child.isFile() && UUID_JSONL.test(child.name)) {
        files.push({ path: resolve(projectDir, child.name), provider: 'claude', kind: 'session' })
      }
    }
  }

  for (const file of walkJsonl(root)) {
    if (!isClaudeSubagentTranscript(file)) continue
    const parentPath = parentPathForSubagent(file)
    files.push({ path: resolve(file), provider: 'claude', kind: 'subagent', parentPath })
  }

  return files.sort(compareSources)
}

export function discoverCodexSessions(root: string): SourceFile[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  return walkJsonl(root)
    .filter(isCodexRollout)
    .map((path) => ({ path: resolve(path), provider: 'codex' as const, kind: 'session' as const }))
    .sort(compareSources)
}

function discoverExtraRoot(root: string): SourceFile[] {
  if (!existsSync(root)) return []
  const stat = statSync(root)
  const paths = stat.isFile() ? [root] : walkJsonl(root)
  const files: SourceFile[] = []

  for (const path of paths) {
    if (!path.endsWith('.jsonl')) continue
    if (isCodexRollout(path)) {
      files.push({ path: resolve(path), provider: 'codex', kind: 'session' })
      continue
    }
    if (isClaudeSubagentTranscript(path)) {
      const parentPath = parentPathForSubagent(path)
      files.push({ path: resolve(path), provider: 'claude', kind: 'subagent', parentPath })
      continue
    }
    if (isClaudeSessionTranscript(path)) {
      files.push({ path: resolve(path), provider: 'claude', kind: 'session' })
    }
  }

  return files
}

function walkJsonl(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

function isClaudeSessionTranscript(path: string): boolean {
  return basename(dirname(path)).startsWith('-') && UUID_JSONL.test(basename(path))
}

function isClaudeSubagentTranscript(path: string): boolean {
  const parts = path.split(sep)
  return (
    basename(path).startsWith('agent-') &&
    (parts.includes('subagents') || parts.some((part) => part.endsWith('.subagents')))
  )
}

function isCodexRollout(path: string): boolean {
  if (!basename(path).startsWith('rollout-')) return false
  const parts = resolve(path).split(/[\\/]/)
  const file = parts.at(-1)
  const day = parts.at(-2)
  const month = parts.at(-3)
  const year = parts.at(-4)
  return (
    file !== undefined &&
    day !== undefined &&
    month !== undefined &&
    year !== undefined &&
    /^\d{4}$/.test(year) &&
    /^\d{2}$/.test(month) &&
    /^\d{2}$/.test(day)
  )
}

function parentPathForSubagent(path: string): string {
  const absolute = resolve(path)
  const parts = absolute.split(/[\\/]/)
  const subagentRoot = parts.findIndex((part) => part.endsWith('.subagents'))
  if (subagentRoot >= 0) {
    const parentId = parts[subagentRoot]?.slice(0, -'.subagents'.length) ?? ''
    return resolve(parts.slice(0, subagentRoot).join(sep), `${parentId}.jsonl`)
  }

  const subagents = parts.lastIndexOf('subagents')
  if (subagents > 0) {
    const parentId = parts[subagents - 1]
    const project = parts.slice(0, subagents - 1).join(sep)
    return resolve(project, `${parentId}.jsonl`)
  }

  const dir = dirname(absolute)
  return resolve(dir, `${basename(dir)}.jsonl`)
}

function compareSources(a: SourceFile, b: SourceFile): number {
  if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
  if (a.kind !== b.kind) return a.kind === 'session' ? -1 : 1
  const parent = (a.parentPath ?? '').localeCompare(b.parentPath ?? '')
  if (parent !== 0) return parent
  return a.path.localeCompare(b.path)
}
