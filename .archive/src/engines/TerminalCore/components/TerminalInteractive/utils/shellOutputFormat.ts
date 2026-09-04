/**
 * ANSI helpers for read-only terminal command / exit separators.
 * Shared by TerminalReadOnly and Simulator shell replay.
 */

const ANSI_BOLD = "\x1b[1m";
const SEPARATOR_WIDTH = 60;

export const ANSI_DIM = "\x1b[2m";
export const ANSI_RED = "\x1b[31m";
export const ANSI_RESET = "\x1b[0m";

/** Format a "system" chunk as a styled command separator line. */
export function formatSystemChunk(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith("$")) {
    const cmd = trimmed.slice(2).trim();
    const label = ` ${cmd} `;
    const padLen = Math.max(0, SEPARATOR_WIDTH - label.length - 2);
    const leftPad = "─".repeat(2);
    const rightPad = "─".repeat(padLen);
    return `\r\n${ANSI_DIM}${leftPad}${ANSI_RESET}${ANSI_BOLD}${label}${ANSI_RESET}${ANSI_DIM}${rightPad}${ANSI_RESET}\r\n`;
  }

  if (trimmed.startsWith("[exit code:")) {
    const codeMatch = trimmed.match(/\[exit code:\s*(\d+)\]/);
    const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : -1;
    const color = exitCode === 0 ? ANSI_DIM : ANSI_RED;
    const pad = "─".repeat(SEPARATOR_WIDTH);
    return `${color}${pad} ${trimmed}${ANSI_RESET}\r\n`;
  }

  return `${ANSI_DIM}${trimmed}${ANSI_RESET}\r\n`;
}
