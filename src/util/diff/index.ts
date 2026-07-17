/**
 * Diff Utilities
 *
 * Rust-powered diff, patch, and merge operations via Tauri IPC.
 * Includes a lightweight JS parser for splitting unified diffs into old/new
 * values.
 */

// Rust-powered diff/patch/merge
export {
  computeDiff,
  applyPatch,
  applyFuzzyPatch,
  mergeThreeWay,
  isUnifiedDiff,
  extractDiffFilePath,
  type DiffOptions,
  type DiffResult,
  type DiffStats,
  type PatchResult,
  type FuzzyPatchOptions,
  type FuzzyPatchResult,
  type HunkResult,
  type MergeResult,
} from "@src/api/tauri/diff";

// ── Lightweight JS unified diff parser ──

export interface ParsedDiff {
  oldValue: string;
  newValue: string;
}

const UNIFIED_HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Split a unified diff string into old/new plain-text values.
 *
 * Gap placeholder lines are inserted between hunks so that absolute line
 * numbers from @@ headers are preserved in the output strings. Without this,
 * multi-hunk diffs produce wrong line offsets when the diff viewer re-computes
 * a diff from the old/new values.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const lines = diffText.split("\n");
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let seenHunk = false;

  for (const line of lines) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }

    const hunkMatch = UNIFIED_HUNK_RE.exec(line);
    if (hunkMatch) {
      const hunkOldStart = Number.parseInt(hunkMatch[1], 10);
      const hunkNewStart = Number.parseInt(hunkMatch[3], 10);
      if (seenHunk) {
        const oldGap = hunkOldStart - oldCursor;
        const newGap = hunkNewStart - newCursor;
        const gapCount = Math.max(oldGap, newGap, 0);
        for (let i = 0; i < gapCount; i++) {
          if (i < oldGap) oldLines.push("");
          if (i < newGap) newLines.push("");
        }
      }
      seenHunk = true;
      oldCursor = hunkOldStart;
      newCursor = hunkNewStart;
      continue;
    }

    if (line.startsWith("-")) {
      oldLines.push(line.substring(1));
      oldCursor++;
    } else if (line.startsWith("+")) {
      newLines.push(line.substring(1));
      newCursor++;
    } else if (line.startsWith(" ") || line === "") {
      const content = line.startsWith(" ") ? line.substring(1) : line;
      oldLines.push(content);
      newLines.push(content);
      oldCursor++;
      newCursor++;
    }
  }

  return {
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
  };
}
