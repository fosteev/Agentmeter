#!/usr/bin/env node
/**
 * agentmeter — цифры в терминале, без GUI.
 *
 * Команды появляются по мере готовности ядра: пока пусто, потому что показывать
 * непроверенные числа хуже, чем не показывать никаких (см. этап 1.3).
 */

const COMMANDS = ['today', 'tasks', 'breakdown', 'limits', 'doctor', 'verify'] as const

function usage(): string {
  return ['agentmeter <команда>', '', `команды: ${COMMANDS.join(', ')}`].join('\n')
}

export function run(argv: readonly string[]): number {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }
  console.error(`команда «${command}» ещё не реализована`)
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)))
}
