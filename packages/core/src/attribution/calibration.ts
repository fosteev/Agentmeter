import type { PrefixCategory } from '../sources/types.ts'

/**
 * Замер `scripts/probe/calibrate-prefix.sh`: 9 августа 2026, Claude Code
 * 2.1.226. У Codex стенда пока не было, поэтому видимые блоки временно
 * наследуют коэффициенты Claude и остаются оценкой.
 */
export const PREFIX_BYTES_PER_TOKEN: Readonly<Record<PrefixCategory, number>> = {
  system: 4.11,
  toolSchemas: 4.11,
  deferredTools: 2.6,
  mcpTools: 2.6,
  mcpInstructions: 3.68,
  skills: 4.05,
  agents: 4.22,
  memory: 4.11,
  userTurn: 3.02,
}
