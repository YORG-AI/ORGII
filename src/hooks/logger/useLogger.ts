/**
 * Unified logging system - the single frontend logging facade.
 *
 * Responsibilities:
 * - Provide one set of `Logger` instances (`createLogger(ns)` / `useLogger(ns)`)
 *   and a global `logger`.
 * - Gate devtools output by a single `currentLevel` (default DEBUG in dev,
 *   WARN in prod). The legacy `consoleManager` is folded into this gate.
 * - Persist every emitted log line to `~/.orgii/logs/frontend.log` via the
 *   Rust `write_frontend_log` Tauri command (the only live backend channel —
 *   `tauri-plugin-log` has been removed on the Rust side).
 * - Optionally intercept native `console.*` calls and route them through the
 *   same level gate + file persistence. Installed once from `index.tsx`.
 *
 * Call-site API (variadic args, matches legacy `createLogger` surface):
 *   const log = createLogger("MyModule");
 *   log.info("Sent message", { id });
 *   log.warn("recoverable:", err);
 *   log.error("fatal", err);
 *   log.debug("trace info", payload);
 *   log.critical("never-suppressed error");           // always reaches devtools + file
 *   log.rateLimited("status-key", 60_000, "ping...");
 *   log.group("Title", () => { log.info("..."); });
 *   log.styled("background:#0a0", "Connected");
 *   log.perfStart("load"); ...; log.perfEnd("load");
 *
 * React API (same instance, memoized per context):
 *   const log = useLogger("MyComponent");
 *
 * Level control:
 *   setLogLevel(LogLevel.INFO);   // tweak at runtime
 *   logger.setLevel(LogLevel.WARN);
 */
import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";

// ============================================================================
// Types & level table
// ============================================================================

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  NONE = 5,
}

/** Alias — devtools `console.log` maps to INFO. */
export const LOG_LEVEL_LOG = LogLevel.INFO;

type LevelName = "trace" | "debug" | "info" | "warn" | "error" | "critical";

const LEVEL_PRIORITY: Record<LevelName, number> = {
  trace: LogLevel.TRACE,
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  critical: LogLevel.ERROR, // critical bypasses the gate, but for sorting it sits with error
};

export interface Logger {
  log: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /**
   * ALWAYS emits to devtools and to ~/.orgii/logs/frontend.log regardless of
   * the current level. Reserved for unrecoverable / startup-fatal errors.
   */
  critical: (...args: unknown[]) => void;
  /** Rate-limit a log message by a stable key. */
  rateLimited: (key: string, intervalMs: number, ...args: unknown[]) => void;
  /** Rate-limited warning that is still persisted when not throttled. */
  warnRateLimited: (
    key: string,
    intervalMs: number,
    ...args: unknown[]
  ) => void;
  /** Open a console group (suppressed when the gate would suppress `log`). */
  group: (
    title: string,
    callback: () => void,
    options?: { collapsed?: boolean }
  ) => void;
  /** `%c` styled log row (info-level). */
  styled: (style: string, ...args: unknown[]) => void;
  perfStart: (label: string) => void;
  perfEnd: (label: string) => void;
  setLevel: (level: LogLevel) => void;
  getLevel: () => LogLevel;
}

// ============================================================================
// Environment
// ============================================================================

export function isTauriRuntimeHost(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "__TAURI_INTERNALS__" in value
  );
}

const isTauriRuntime =
  typeof window !== "undefined" && isTauriRuntimeHost(window);
const isDev = process.env.NODE_ENV === "development";
const forceDebugFromUrl =
  typeof window !== "undefined" &&
  typeof window.location !== "undefined" &&
  new URLSearchParams(window.location.search).get("debug") === "true";

// Single source of truth for level gating. Mutable so `setLogLevel` works.
let currentLevel: LogLevel =
  isDev || forceDebugFromUrl ? LogLevel.DEBUG : LogLevel.WARN;

const CONSOLE_INTERCEPTOR_INSTALLED = "__orgii_console_interceptor_installed__";

// Captured at module load — the genuine console methods, used internally so
// we never re-enter our own interceptor.
const nativeConsole = (() => {
  if (typeof window === "undefined" || !window.console) {
    return null;
  }
  const c = window.console;
  return {
    log: c.log.bind(c),
    info: c.info.bind(c),
    warn: c.warn.bind(c),
    error: c.error.bind(c),
    debug: c.debug.bind(c),
    trace: c.trace.bind(c),
    group: c.group.bind(c),
    groupCollapsed: c.groupCollapsed.bind(c),
    groupEnd: c.groupEnd.bind(c),
  };
})();

// ============================================================================
// Formatting helpers
// ============================================================================

function formatOne(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) {
    // WebKit stacks omit the message line, so always lead with name+message.
    const head = `${value.name}: ${value.message}`;
    return value.stack && !value.stack.startsWith(head)
      ? `${head}\n${value.stack}`
      : value.stack || head;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      try {
        return Object.prototype.toString.call(value);
      } catch {
        return "[Object]";
      }
    }
  }
  return String(value);
}

function formatArgs(args: unknown[]): string {
  return args.map(formatOne).join(" ");
}

// ============================================================================
// Backend persistence
// ============================================================================

let backendUnavailable = false;

function writeToBackend(
  level: LevelName,
  namespace: string,
  message: string
): void {
  if (backendUnavailable || !isTauriRuntime) return;
  invoke("write_frontend_log", { level, namespace, message }).catch(() => {
    // The Rust command may not exist yet on first launch / older binary.
    // Stop trying after the first failure so we don't spam the IPC bridge.
    backendUnavailable = true;
  });
}

// ============================================================================
// Devtools emission (gate + native console)
// ============================================================================

function shouldEmit(level: LevelName): boolean {
  if (currentLevel >= LogLevel.NONE) return false;
  return LEVEL_PRIORITY[level] >= currentLevel;
}

function emitToConsole(
  level: LevelName,
  namespace: string,
  args: unknown[]
): void {
  if (!nativeConsole) return;
  const prefix = `[${namespace}]`;
  switch (level) {
    case "trace":
      nativeConsole.trace(prefix, ...args);
      return;
    case "debug":
      nativeConsole.debug(prefix, ...args);
      return;
    case "info":
      nativeConsole.info(prefix, ...args);
      return;
    case "warn":
      nativeConsole.warn(prefix, ...args);
      return;
    case "error":
    case "critical":
      nativeConsole.error(prefix, ...args);
      return;
  }
}

function emit(
  level: LevelName,
  namespace: string,
  args: unknown[],
  options?: { bypassGate?: boolean }
): void {
  const passesGate = options?.bypassGate || shouldEmit(level);
  if (passesGate) {
    emitToConsole(level, namespace, args);
  }
  // Persist on every call (including suppressed devtools output) when the
  // priority is >= INFO; debug/trace are dev-only noise and shouldn't bloat
  // the log file. `critical` always persists.
  if (
    options?.bypassGate ||
    LEVEL_PRIORITY[level] >= LogLevel.INFO ||
    LEVEL_PRIORITY[level] >= currentLevel
  ) {
    writeToBackend(level, namespace, formatArgs(args));
  }
}

// ============================================================================
// Rate-limit cache (shared across all loggers)
// ============================================================================

const rateLimitCache = new Map<string, number>();
const MAX_RATE_LIMIT_ENTRIES = 500;
const RATE_LIMIT_EVICT_AGE_MS = 5 * 60 * 1000;

function takeRateLimitSlot(key: string, intervalMs: number): boolean {
  const now = Date.now();
  const last = rateLimitCache.get(key);
  if (last !== undefined && now - last < intervalMs) {
    return false;
  }
  rateLimitCache.set(key, now);
  if (rateLimitCache.size > MAX_RATE_LIMIT_ENTRIES) {
    for (const [cachedKey, ts] of rateLimitCache) {
      if (now - ts > RATE_LIMIT_EVICT_AGE_MS) {
        rateLimitCache.delete(cachedKey);
      }
    }
  }
  return true;
}

// ============================================================================
// Perf marks (shared across all loggers, namespaced via createLogger)
// ============================================================================

const perfMarks = new Map<string, number>();

// ============================================================================
// Logger factory
// ============================================================================

function makeLogger(namespace: string): Logger {
  return {
    log: (...args) => emit("info", namespace, args),
    trace: (...args) => emit("trace", namespace, args),
    debug: (...args) => emit("debug", namespace, args),
    info: (...args) => emit("info", namespace, args),
    warn: (...args) => emit("warn", namespace, args),
    error: (...args) => emit("error", namespace, args),
    critical: (...args) =>
      emit("critical", namespace, args, { bypassGate: true }),
    rateLimited: (key, intervalMs, ...args) => {
      if (!takeRateLimitSlot(key, intervalMs)) return;
      emit("info", namespace, args);
    },
    warnRateLimited: (key, intervalMs, ...args) => {
      if (!takeRateLimitSlot(key, intervalMs)) return;
      emit("warn", namespace, args);
    },
    group: (title, callback, options) => {
      if (!shouldEmit("info")) {
        callback();
        return;
      }
      const prefix = `[${namespace}] ${title}`;
      if (nativeConsole) {
        if (options?.collapsed) {
          nativeConsole.groupCollapsed(prefix);
        } else {
          nativeConsole.group(prefix);
        }
      }
      try {
        callback();
      } finally {
        nativeConsole?.groupEnd();
      }
    },
    styled: (style, ...args) => {
      if (!shouldEmit("info") || !nativeConsole) {
        writeToBackend("info", namespace, formatArgs(args));
        return;
      }
      nativeConsole.log(`%c[${namespace}]`, style, ...args);
      writeToBackend("info", namespace, formatArgs(args));
    },
    perfStart: (label) => {
      perfMarks.set(`${namespace}:${label}`, performance.now());
    },
    perfEnd: (label) => {
      const key = `${namespace}:${label}`;
      const startTime = perfMarks.get(key);
      if (startTime === undefined) {
        emit("warn", namespace, [`No perfStart mark found for: ${label}`]);
        return;
      }
      const durationMs = performance.now() - startTime;
      perfMarks.delete(key);
      emit("info", namespace, [`${label}: ${durationMs.toFixed(2)}ms`]);
    },
    setLevel: (level) => {
      currentLevel = level;
    },
    getLevel: () => currentLevel,
  };
}

// ============================================================================
// Public factories
// ============================================================================

export function createLogger(namespace: string): Logger {
  return makeLogger(namespace);
}

export function useLogger(namespace: string): Logger {
  return useMemo(() => makeLogger(namespace), [namespace]);
}

/** Global, namespace-less logger for ad-hoc call sites. */
export const logger: Logger = makeLogger("Global");

// ============================================================================
// Top-level convenience helpers (legacy API surface)
// ============================================================================

export function log(namespace: string, ...args: unknown[]): void {
  emit("info", namespace, args);
}

export function logInfo(namespace: string, ...args: unknown[]): void {
  emit("info", namespace, args);
}

export function logDebug(namespace: string, ...args: unknown[]): void {
  emit("debug", namespace, args);
}

export function logWarn(namespace: string, ...args: unknown[]): void {
  emit("warn", namespace, args);
}

export function logError(namespace: string, ...args: unknown[]): void {
  emit("error", namespace, args);
}

export function criticalError(namespace: string, ...args: unknown[]): void {
  emit("critical", namespace, args, { bypassGate: true });
}

export function styledLog(
  namespace: string,
  style: string,
  ...args: unknown[]
): void {
  if (!shouldEmit("info") || !nativeConsole) {
    writeToBackend("info", namespace, formatArgs(args));
    return;
  }
  nativeConsole.log(`%c[${namespace}]`, style, ...args);
  writeToBackend("info", namespace, formatArgs(args));
}

export function logGroup(
  namespace: string,
  title: string,
  callback: () => void,
  options: { collapsed?: boolean; force?: boolean } = {}
): void {
  if (!options.force && !shouldEmit("info")) {
    callback();
    return;
  }
  const prefix = `[${namespace}] ${title}`;
  if (nativeConsole) {
    if (options.collapsed) {
      nativeConsole.groupCollapsed(prefix);
    } else {
      nativeConsole.group(prefix);
    }
  }
  try {
    callback();
  } finally {
    nativeConsole?.groupEnd();
  }
}

export function perfStart(label: string): void {
  perfMarks.set(label, performance.now());
}

export function perfEnd(label: string): void {
  const startTime = perfMarks.get(label);
  if (startTime === undefined) {
    emit("warn", "perf", [`No perfStart mark found for: ${label}`]);
    return;
  }
  const durationMs = performance.now() - startTime;
  perfMarks.delete(label);
  emit("info", "perf", [`${label}: ${durationMs.toFixed(2)}ms`]);
}

export function logRateLimited(
  key: string,
  intervalMs: number,
  namespace: string,
  ...args: unknown[]
): void {
  if (!takeRateLimitSlot(key, intervalMs)) return;
  emit("info", namespace, args);
}

export function logWarnRateLimited(
  key: string,
  intervalMs: number,
  namespace: string,
  ...args: unknown[]
): void {
  if (!takeRateLimitSlot(key, intervalMs)) return;
  emit("warn", namespace, args);
}

// ============================================================================
// Level control
// ============================================================================

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

// ============================================================================
// Console interceptor — installs the same level gate over native console.*
// so legacy direct `console.info` / `console.log` calls (and 3rd-party libs
// like i18next) participate in the same control plane.
// ============================================================================

function installConsoleInterceptor(): void {
  if (typeof window === "undefined" || !nativeConsole) return;
  const w = window as unknown as Record<string, boolean | undefined>;
  if (w[CONSOLE_INTERCEPTOR_INSTALLED]) return;

  const intercept = (level: LevelName) => {
    return (...args: unknown[]) => {
      const passesGate = shouldEmit(level);
      if (passesGate) {
        switch (level) {
          case "trace":
            nativeConsole.trace(...args);
            break;
          case "debug":
            nativeConsole.debug(...args);
            break;
          case "info":
            nativeConsole.info(...args);
            break;
          case "warn":
            nativeConsole.warn(...args);
            break;
          case "error":
          case "critical":
            nativeConsole.error(...args);
            break;
        }
      }
      // Always persist warn/error/critical; persist info-and-below only when
      // they would also reach devtools (gate-aware), to avoid filling the log
      // file with debug noise in dev.
      if (LEVEL_PRIORITY[level] >= LogLevel.WARN || passesGate) {
        writeToBackend(level, "console", formatArgs(args));
      }
    };
  };

  const c = window.console;
  c.log = intercept("info");
  c.info = intercept("info");
  c.debug = intercept("debug");
  c.trace = intercept("trace");
  c.warn = intercept("warn");
  c.error = intercept("error");

  w[CONSOLE_INTERCEPTOR_INSTALLED] = true;
}

/**
 * Initialize the logging system. Safe to call multiple times.
 * Called synchronously from `index.tsx` so every subsequent `console.*`
 * (including startup-period output from 3rd-party libs) goes through the
 * level gate.
 */
export function initializeLogging(): void {
  try {
    installConsoleInterceptor();
  } catch (err) {
    // Fall back to raw native console for the failure itself, since the
    // interceptor obviously can't be trusted right now.
    nativeConsole?.warn("[Logger] Failed to install console interceptor:", err);
  }
}
