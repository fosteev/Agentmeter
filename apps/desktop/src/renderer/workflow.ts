/**
 * Общее для экрана Workflow и его настроек (9.5): подписи ролей и вердиктов.
 *
 * Подписи пяти ролей конфига и четырёх вердиктов уже лежат в каталоге (9.2,
 * `roleLabel`/`verdictLabel` в ядре) — но ядро целиком в окно не пускают
 * (`node:sqlite`), поэтому здесь те же ключи, по которым зовётся `t()`. Свою
 * копию слов заводить нельзя: ключ один. Для главной сессии ключ завела 9.5.
 *
 * В константах лежат **ключи**: `t()` на верхнем уровне модуля застыл бы на
 * языке загрузки.
 */
import type { WorkflowRoleKey, WorkflowVerdictKey } from '@agentmeter/ipc'
import { t } from './format.ts'

const ROLE_KEYS = {
  main: 'workflow.roleMain',
  executor: 'workflow.roleExecutor',
  reviewer: 'workflow.roleReviewer',
  planner: 'workflow.rolePlanner',
  explore: 'workflow.roleExplore',
  unknown: 'workflow.roleUnknown',
} as const satisfies Record<WorkflowRoleKey, string>

const VERDICT_KEYS = {
  accepted: 'workflow.verdictAccepted',
  notes: 'workflow.verdictNotes',
  rejected: 'workflow.verdictRejected',
  none: 'workflow.verdictNone',
} as const satisfies Record<WorkflowVerdictKey, string>

export function roleName(role: WorkflowRoleKey): string {
  return t(ROLE_KEYS[role])
}

export function verdictName(verdict: WorkflowVerdictKey): string {
  return t(VERDICT_KEYS[verdict])
}

/** Шрифт и разрядка подписей-«шапок» экрана — одна на все блоки раздела 13. */
export const MONO = "'IBM Plex Mono', monospace"
