export type {
  Provider,
  PrefixCategory,
  PrefixBlock,
  MarginalBasis,
  Entrypoint,
  Session,
  Request,
  ToolCall,
  ToolFile,
  ToolKind,
  LiveSession,
  LimitWindow,
  LimitWindowKind,
  LimitObservation,
  LimitUsage,
  ParseResult,
  ParseDiagnostics,
} from './sources/types.ts'

export { emptyDiagnostics } from './sources/types.ts'
export { attributeMarginal, attributePrefix, PREFIX_BYTES_PER_TOKEN } from './attribution/index.ts'
export type { MarginalOptions, MarginalStats, PrefixOptions } from './attribution/index.ts'
export { buildClaudeWindows, buildCodexWindows, currentWindows } from './limits/index.ts'
export type { LimitRequest } from './limits/index.ts'
export { listLiveSessions, parseSessionFile, parseSubagents } from './sources/claude/index.ts'
export { parseRolloutFile, readLimits } from './sources/codex/index.ts'
export { defaultClaudeHome, defaultCodexHome, defaultIndexPath } from './index/paths.ts'
export { discoverSources } from './index/discover.ts'
export type { SourceFile, SourceIssue } from './index/discover.ts'
export { putSource, putSession, forgetSource } from './index/store.ts'
export { ingestSteps, ingestAll, ingestFile } from './index/ingest.ts'
export type { DiscoverOpts, IngestOptions, IngestProgress, IngestStats } from './index/ingest.ts'
export {
  ensureLimitWindows,
  putLimitObservations,
  readLimitWindows,
  rebuildLimitWindows,
} from './index/limits.ts'
export type { LimitWindowStats } from './index/limits.ts'
export { createLiveLayer } from './live/index.ts'
export type { LiveLayer, LiveLayerOptions, LiveOptions } from './live/index.ts'
export { DEFAULT_LIVE_OPTIONS, appendLifetimes, loadLifetimes, processState } from './live/index.ts'
export type {
  ContextFill,
  LiveAgent,
  LiveSnapshot,
  LiveState,
  SessionLifetime,
} from './live/index.ts'
export { CLAUDE_WINDOWS, OBSERVED_WINDOW_DAYS, windowFromObserved } from './live/index.ts'
export { claudeTurn, codexTurn, deriveState, readTurn } from './live/index.ts'
export type { StateInput, TurnKind, TurnRead } from './live/index.ts'
export {
  DEFAULT_RATE_WINDOW_MS,
  RATE_FLOOR_MS,
  observedSpan,
  perMinute,
  windowTokens,
} from './live/index.ts'
export { CSV_BOM, EXPORT_COLUMNS, exportRows, toCsv } from './export/index.ts'
export type { ExportGrain, ExportRow } from './export/index.ts'
export { watchSources } from './index/watch.ts'
export type { Watcher } from './index/watch.ts'
export { openDb } from './index/db.ts'
export type { Db } from './index/db.ts'
export {
  applyPatch,
  claudeHome,
  codexHome,
  configDir,
  configPath,
  indexPath,
  lifetimesPath,
  loadConfig,
  saveConfig,
} from './config/load.ts'
export { DEFAULT_CONFIG } from './config/types.ts'
export type { ClaudeLimits, Config, WindowBounds } from './config/types.ts'
export type { LoadResult } from './config/load.ts'
export { RULES, rulePathsInDefaults } from './config/validate.ts'
export * from './query/index.ts'
/**
 * Формат чисел живёт и отдельной точкой входа (`@agentmeter/core/format`):
 * рендерер обязан брать его без этого файла, иначе в браузерный бандл уедет
 * `node:sqlite`. Здесь он для CLI и тестов, которые и так тянут ядро целиком.
 */
export { formatTokens } from './format/tokens.ts'

/**
 * Тексты интерфейса. Здесь — для main и CLI; рендерер берёт их подпутём
 * `@agentmeter/core/i18n` по той же причине, что форматтер.
 */
export { locale, setLocale, t, LOCALES, resolveLocale } from './i18n/index.ts'
export type { Locale, LocaleSetting } from './i18n/locale.ts'
