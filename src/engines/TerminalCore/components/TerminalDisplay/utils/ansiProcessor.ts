/**
 * ANSI Processing Utilities
 *
 * Extracted from RunCommand and TerminalBlock to eliminate duplication.
 * Handles ANSI escape sequences and terminal control codes.
 */

/**
 * Process ANSI content for clean display
 * Strips cursor control sequences while preserving color codes
 *
 * @param content - Raw terminal output with ANSI codes
 * @returns Cleaned content ready for ansi-to-react
 */
export function processAnsiContent(content: string): string {
  if (!content || typeof content !== "string") return "";

  return (
    content
      // Normalize line endings
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Remove cursor positioning codes (ESC[nG - move to column n)
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9]*[GK]/g, "")
      // Remove cursor up codes (ESC[nA - move up n lines)
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9]*[A]/g, "")
  );
}

/**
 * Strip all ANSI escape codes (for plain text output)
 *
 * @param content - Terminal output with ANSI codes
 * @returns Plain text without any ANSI codes
 */
export function stripAnsiCodes(content: string): string {
  if (!content || typeof content !== "string") return "";

  // Remove all ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  return content.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Check if content contains ANSI codes
 *
 * @param content - Content to check
 * @returns True if content has ANSI escape sequences
 */
export function hasAnsiCodes(content: string): boolean {
  if (!content || typeof content !== "string") return false;

  // eslint-disable-next-line no-control-regex
  return /\u001b\[[0-9;]*[a-zA-Z]/.test(content);
}

/**
 * Detect TUI-style terminal output that requires a real VT100 renderer.
 *
 * Returns true when the content contains escape sequences that ansi-to-react
 * cannot handle correctly: cursor movement, erase sequences, alternate screen,
 * or carriage-return-based in-place rewrites (spinners, progress bars).
 *
 * These are the heuristics:
 *   - ESC[H / ESC[f  — cursor absolute position (TUI screen layout)
 *   - ESC[A/B/C/D    — cursor movement (progress bars, spinners)
 *   - ESC[J / ESC[K  — erase in screen / line (redraw)
 *   - ESC[?47h / ESC[?1049h  — alternate screen (full TUI apps)
 *   - \r (CR without LF)  — carriage-return rewrite (spinner, progress bar)
 *   - ESC[?25l / ESC[?25h   — cursor hide/show (TUI frame coalescing)
 */
export function hasTuiSequences(content: string): boolean {
  if (!content || typeof content !== "string") return false;

  // eslint-disable-next-line no-control-regex
  if (/\u001b\[[\d;]*[ABCDEFGHJ KM]/.test(content)) return true;
  // Alternate screen switch
  // eslint-disable-next-line no-control-regex
  if (/\u001b\[\?(?:47|1047|1048|1049)[hl]/.test(content)) return true;
  // Cursor show/hide
  // eslint-disable-next-line no-control-regex
  if (/\u001b\[\?25[lh]/.test(content)) return true;
  // CR-based rewrite (spinner / progress bar) — \r not followed by \n
  if (/\r(?!\n)/.test(content)) return true;
  return false;
}
