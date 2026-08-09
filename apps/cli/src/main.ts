#!/usr/bin/env node
/**
 * agentmeter — цифры в терминале, без GUI.
 *
 * Команды появляются по мере готовности ядра: пока пусто, потому что показывать
 * непроверенные числа хуже, чем не показывать никаких (см. этап 1.3).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultIndexPath, ingestAll, openDb } from '@agentmeter/core'

const COMMANDS = ['today', 'tasks', 'breakdown', 'limits', 'doctor', 'verify', 'index'] as const

function usage(): string {
  return [
    'agentmeter <команда>',
    '',
    `команды: ${COMMANDS.join(', ')}`,
    '',
    'agentmeter index [--rebuild] [--json]',
  ].join('\n')
}

export function run(argv: readonly string[]): number {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }
  if (command === 'index') return runIndex(argv.slice(1))
  console.error(`команда «${command}» ещё не реализована`)
  return 1
}

function runIndex(argv: readonly string[]): number {
  const rebuild = argv.includes('--rebuild')
  const asJson = argv.includes('--json')
  const unknown = argv.find((arg) => arg !== '--rebuild' && arg !== '--json')
  if (unknown) {
    console.error(`неизвестный флаг index: ${unknown}`)
    return 1
  }

  const path = defaultIndexPath()
  mkdirSync(dirname(path), { recursive: true })
  if (rebuild) removeIndex(path)

  const { db } = openDb(path)
  try {
    const stats = ingestAll(db)
    if (asJson) {
      console.log(JSON.stringify(stats))
    } else {
      console.log(
        `scanned=${stats.scanned} parsed=${stats.parsed} skipped=${stats.skipped} removed=${stats.removed} ` +
          `failed=${stats.failed} sessions=${stats.sessions} requests=${stats.requests} ms=${stats.ms}`,
      )
    }
    return stats.failed === 0 ? 0 : 1
  } finally {
    db.close()
  }
}

function removeIndex(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${path}${suffix}`
    if (existsSync(candidate)) rmSync(candidate, { force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)))
}
