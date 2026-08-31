/**
 * Git Output Formatters
 *
 * Timestamp formatting utilities for git output messages.
 */

/**
 * Format a Date object to a VS Code-style timestamp string.
 * Format: YYYY-MM-DD HH:MM:SS.mmm
 * Styled with ANSI dim and italic codes.
 */
export function formatTimestampFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  // Apply text-3 color (dimmed) and italic using ANSI codes
  return `\x1b[2m\x1b[3m${timestamp}\x1b[0m`;
}

/**
 * Format current time to a VS Code-style timestamp string.
 * Convenience wrapper around formatTimestampFromDate.
 */
export function formatTimestamp(): string {
  return formatTimestampFromDate(new Date());
}

// ============================================
// ANSI Color Codes
// ============================================

export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
} as const;

// ============================================
// Message Formatters
// ============================================

/** Format info message (cyan [info] prefix) */
export function formatInfoMessage(timestamp: string, text: string): string {
  return `${timestamp} ${ANSI.cyan}[info]${ANSI.reset} ${text}\n`;
}

/** Format command message (cyan [info] with > prefix) */
export function formatCommandMessage(
  timestamp: string,
  command: string
): string {
  return `${timestamp} ${ANSI.cyan}[info]${ANSI.reset} > ${command}\n`;
}

/** Format success message (green [info] with checkmark) */
export function formatSuccessMessage(
  timestamp: string,
  operation: string,
  durationMs: number
): string {
  return `${timestamp} ${ANSI.green}[info]${ANSI.reset} ✓ ${operation} completed [${ANSI.gray}${durationMs}ms${ANSI.reset}]\n`;
}

/** Format error message (red [error] with X) */
export function formatErrorMessage(
  timestamp: string,
  operation: string,
  durationMs?: number
): string {
  const durationPart =
    durationMs !== undefined
      ? ` [${ANSI.gray}${durationMs}ms${ANSI.reset}]`
      : "";
  return `${timestamp} ${ANSI.red}[error]${ANSI.reset} ✗ ${operation} failed${durationPart}\n`;
}

/** Format error detail message (red [error] with X) */
export function formatErrorDetail(timestamp: string, error: string): string {
  return `${timestamp} ${ANSI.red}[error]${ANSI.reset} ✗ ${error}\n`;
}

/** Format watch message (cyan or yellow [watch] prefix) */
export function formatWatchMessage(
  timestamp: string,
  eventType: "start" | "change" | "end" | "idle",
  details?: string
): string {
  const detailsStr = details ? ` - ${details}` : "";
  const color = eventType === "change" ? ANSI.yellow : ANSI.cyan;
  const dimPrefix = eventType === "idle" ? ANSI.gray : color;

  const messages: Record<string, string> = {
    start: `File watcher started${detailsStr}`,
    change: `File changes detected${detailsStr}`,
    end: `File watcher stopped${detailsStr}`,
    idle: `${ANSI.dim}No changes detected${detailsStr}${ANSI.reset}`,
  };

  return `${timestamp} ${dimPrefix}[watch]${ANSI.reset} ${messages[eventType]}\n`;
}
