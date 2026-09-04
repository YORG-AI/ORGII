// Unified logging facade — re-exports the full public API from useLogger.
// This is the ONLY logger module in the codebase; `src/util/logger.ts` was
// removed in favour of routing everything through here.
export {
  // Factories
  createLogger,
  useLogger,
  logger,

  // Top-level convenience helpers (variadic, namespace-first)
  log,
  logDebug,
  logWarn,
  logError,

  // Lifecycle + level control
  initializeLogging,
  LogLevel,
} from "./useLogger";

export type { Logger } from "./useLogger";
