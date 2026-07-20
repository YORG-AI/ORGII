export { parseUnifiedDiff, type ParsedDiff } from "@src/util/diff/unifiedDiff";

const DIFF_HEADER_PREFIXES = ["@@", "diff ", "index ", "---", "+++"] as const;

function isDiffHeader(line: string): boolean {
  return DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * Truncates a unified diff string to at most `visibleLines` displayable lines
 * (header lines — @@, diff, index, ---, +++ — are not counted toward the
 * limit and are always preserved so the truncated string remains parseable).
 *
 * Returns the truncated unified diff string. Callers should pass the result
 * to `parseUnifiedDiff` when they need old/new values.
 */
export function truncateDiff(
  unifiedDiff: string,
  visibleLines: number
): string {
  const lines = unifiedDiff.split("\n");
  const result: string[] = [];
  let displayableCount = 0;

  for (const line of lines) {
    if (isDiffHeader(line)) {
      result.push(line);
      continue;
    }

    if (displayableCount >= visibleLines) {
      break;
    }

    result.push(line);
    displayableCount++;
  }

  return result.join("\n");
}

/** Default number of lines to show before "Show more" */
export const DEFAULT_VISIBLE_LINES = 15;

/** Threshold for virtual scrolling (only for expanded large files) */
export const VIRTUAL_SCROLL_THRESHOLD = 100;

/** Line height for virtual scrolling */
export const VIRTUAL_LINE_HEIGHT = 18;
