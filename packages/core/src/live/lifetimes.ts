/**
 * Журнал времени жизни сессий — единственные данные проекта, которые ниоткуда
 * не восстанавливаются.
 *
 * Поэтому он **не в индексе**. Индекс полностью производен от логов, на этом
 * держится дешёвая миграция «снести и перечитать» (правило 3 в `schema.ts`), и
 * она уже применялась — версия 4. Положить сюда невосстановимое значило бы
 * поставить его в зависимость от ветки кода, которая до 1.10 не выполнялась ни
 * разу и падала.
 *
 * Формат — JSONL, дозапись в конец, последняя запись про `sessionId`
 * побеждает. Так замер можно показать человеку как журнал наблюдений, а не
 * только скормить коду; и порванная на середине строка стоит одного
 * наблюдения, а не всего файла.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Provider } from '../sources/types.ts'
import type { SessionLifetime } from './types.ts'

export function loadLifetimes(path: string): Map<string, SessionLifetime> {
  const out = new Map<string, SessionLifetime>()
  if (!existsSync(path)) return out

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }

  for (const line of text.split('\n')) {
    const record = parseLifetime(line)
    if (record) out.set(record.sessionId, record)
  }
  return out
}

export function appendLifetimes(path: string, records: readonly SessionLifetime[]): void {
  if (records.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8')
}

function parseLifetime(line: string): SessionLifetime | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const raw: unknown = JSON.parse(trimmed)
    if (typeof raw !== 'object' || raw === null) return undefined
    const value = raw as Record<string, unknown>
    const sessionId = value['sessionId']
    const provider = value['provider']
    const startedAt = value['startedAt']
    const firstSeenAt = value['firstSeenAt']
    const lastSeenAt = value['lastSeenAt']
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    if (provider !== 'claude' && provider !== 'codex') return undefined
    if (
      typeof startedAt !== 'number' ||
      typeof firstSeenAt !== 'number' ||
      typeof lastSeenAt !== 'number'
    ) {
      return undefined
    }

    const record: SessionLifetime = {
      sessionId,
      provider: provider as Provider,
      pid: typeof value['pid'] === 'number' ? value['pid'] : null,
      startedAt,
      firstSeenAt,
      lastSeenAt,
      endedAt: typeof value['endedAt'] === 'number' ? value['endedAt'] : null,
      lastRequestTs: typeof value['lastRequestTs'] === 'number' ? value['lastRequestTs'] : null,
    }
    if (typeof value['cliVersion'] === 'string') record.cliVersion = value['cliVersion']
    return record
  } catch {
    // Оборванная строка — потеря одного наблюдения. Ронять из-за неё весь
    // журнал нельзя: он копится месяцами и второй копии у него нет.
    return undefined
  }
}
