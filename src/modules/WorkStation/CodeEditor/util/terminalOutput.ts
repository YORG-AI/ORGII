/**
 * Terminal Output Utilities
 *
 * Shared utilities for processing terminal/shell output strings.
 * Centralizes truncation and escape handling to ensure consistent
 * performance behavior across all terminal display components.
 *
 * PERFORMANCE: Truncation should happen at data ingestion time (atoms/stores)
 * rather than at render time to avoid processing large strings in components.
 */

// ============================================
// Constants
// ============================================

/**
 * Maximum length for terminal output before truncation.
 * 10KB is a reasonable limit that covers most use cases while
 * preventing memory/render issues with very large outputs.
 */
export const TERMINAL_OUTPUT_MAX_LENGTH = 10_000;

/**
 * Suffix appended to truncated output (localized in components)
 */
export const TERMINAL_TRUNCATION_MARKER = "\n... [truncated]";

// ============================================
// Functions
// ============================================

/**
 * Unescape string content from streaming/encoded terminal output.
 * Handles common escape sequences from PTY/shell processes.
 */
export function unescapeTerminalString(str: string | undefined): string {
  if (!str) return "";
  try {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  } catch {
    return str;
  }
}

/**
 * Truncate terminal output to a safe length.
 *
 * @param output - Raw terminal output string
 * @param maxLength - Maximum length (default: TERMINAL_OUTPUT_MAX_LENGTH)
 * @param marker - Truncation marker (default: TERMINAL_TRUNCATION_MARKER)
 * @returns Truncated string if over limit, original otherwise
 */
export function truncateTerminalOutput(
  output: string,
  maxLength: number = TERMINAL_OUTPUT_MAX_LENGTH,
  marker: string = TERMINAL_TRUNCATION_MARKER
): string {
  if (output.length <= maxLength) {
    return output;
  }
  return output.slice(0, maxLength) + marker;
}

/**
 * Process terminal output: unescape and truncate in one pass.
 * Use this at data ingestion time (atoms/stores) for optimal performance.
 *
 * @param rawOutput - Raw terminal output (potentially escaped)
 * @param maxLength - Maximum length (default: TERMINAL_OUTPUT_MAX_LENGTH)
 * @param marker - Truncation marker
 * @returns Processed and truncated string
 */
export function processTerminalOutput(
  rawOutput: string | undefined,
  maxLength: number = TERMINAL_OUTPUT_MAX_LENGTH,
  marker: string = TERMINAL_TRUNCATION_MARKER
): string {
  const unescaped = unescapeTerminalString(rawOutput);
  return truncateTerminalOutput(unescaped, maxLength, marker);
}
