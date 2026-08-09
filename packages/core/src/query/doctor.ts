import type { Config } from '../config/types.ts'
import type { Db } from '../index/db.ts'
import { sourceCount } from './today.ts'
import type { DiagnosticRow, DoctorReport } from './types.ts'

interface CountRow {
  count: number
}

export function doctorReport(db: Db, config: Config): DoctorReport {
  const sources = sourceCount(db)
  const diagnostics = db.all<DiagnosticRow>(
    `SELECT kind, detail, sum(count) AS count, cli_version AS cliVersion
     FROM diagnostics
     GROUP BY kind, detail, cli_version
     ORDER BY kind, detail, cli_version`,
  )
  return {
    emptyIndex: sources === 0,
    indexPath:
      db.all<{ file: string }>('PRAGMA database_list').find((row) => row.file !== '')?.file ?? '',
    schemaVersion: Number(
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version')?.value ??
        0,
    ),
    sources,
    sessions: sources === 0 ? null : count(db, 'sessions'),
    requests: sources === 0 ? null : count(db, 'requests'),
    diagnostics,
    parserErrors: diagnostics
      .filter((diagnostic) => diagnostic.kind === 'parser_error')
      .reduce((sum, diagnostic) => sum + diagnostic.count, 0),
    reconstructedSessions:
      db.get<CountRow>(
        "SELECT count(DISTINCT session_id) AS count FROM requests WHERE origin != 'log'",
      )?.count ?? 0,
    calibration: {
      cacheReadWeight: config.limits.claude.cacheReadWeight,
      fiveHourCap: config.limits.claude.fiveHourCap,
      weeklyCap: config.limits.claude.weeklyCap,
      plan: config.limits.claude.plan,
    },
  }
}

function count(db: Db, table: 'sessions' | 'requests'): number {
  return db.get<CountRow>(`SELECT count(*) AS count FROM ${table}`)?.count ?? 0
}
