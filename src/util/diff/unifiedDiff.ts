import type { LineDiffStats } from "./types";

const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export interface ParsedDiff {
  oldValue: string;
  newValue: string;
  oldStartLine?: number;
  newStartLine?: number;
}

export interface ParsedUnifiedDiff extends ParsedDiff {
  stats: LineDiffStats;
}

export interface ParseUnifiedDiffOptions {
  /** Insert placeholder lines between hunks to preserve absolute positions. */
  preserveHunkGaps?: boolean;
  /** How to interpret an empty line without the unified-diff context prefix. */
  unprefixedBlankLine?: "context" | "ignore";
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  bodyLines: string[];
}

interface ParsedDiffInternal extends ParsedUnifiedDiff {
  hunks: ParsedHunk[];
}

function isMetadataLine(line: string): boolean {
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line === "---" ||
    line.startsWith("--- ") ||
    line === "+++" ||
    line.startsWith("+++ ")
  );
}

function parseUnifiedDiffInternal(
  diffText: string,
  options: ParseUnifiedDiffOptions
): ParsedDiffInternal {
  const preserveHunkGaps = options.preserveHunkGaps ?? true;
  const unprefixedBlankLine = options.unprefixedBlankLine ?? "context";
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const hunks: ParsedHunk[] = [];
  let currentHunk: ParsedHunk | null = null;
  let oldStartLine: number | undefined;
  let newStartLine: number | undefined;
  let oldCursor = 0;
  let newCursor = 0;
  let additions = 0;
  let deletions = 0;

  const flushHunk = () => {
    if (!currentHunk) return;
    hunks.push(currentHunk);
    currentHunk = null;
  };

  for (const line of diffText.split("\n")) {
    const hunkMatch = HUNK_HEADER_REGEX.exec(line);
    if (hunkMatch) {
      flushHunk();
      const hunkOldStart = Number.parseInt(hunkMatch[1], 10);
      const hunkNewStart = Number.parseInt(hunkMatch[3], 10);
      if (oldStartLine === undefined) {
        oldStartLine = hunkOldStart;
        newStartLine = hunkNewStart;
      } else if (preserveHunkGaps) {
        const oldGap = hunkOldStart - oldCursor;
        const newGap = hunkNewStart - newCursor;
        const gapCount = Math.max(oldGap, newGap, 0);
        for (let index = 0; index < gapCount; index++) {
          if (index < oldGap) oldLines.push("");
          if (index < newGap) newLines.push("");
        }
      }
      oldCursor = hunkOldStart;
      newCursor = hunkNewStart;
      currentHunk = {
        oldStart: hunkOldStart,
        oldCount: hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1,
        newStart: hunkNewStart,
        newCount: hunkMatch[4] ? Number.parseInt(hunkMatch[4], 10) : 1,
        bodyLines: [],
      };
      continue;
    }

    if (isMetadataLine(line)) continue;

    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      oldCursor++;
      deletions++;
      currentHunk?.bodyLines.push(line);
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      newCursor++;
      additions++;
      currentHunk?.bodyLines.push(line);
    } else if (
      line.startsWith(" ") ||
      (line === "" && unprefixedBlankLine === "context")
    ) {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(content);
      newLines.push(content);
      oldCursor++;
      newCursor++;
      currentHunk?.bodyLines.push(line);
    } else {
      // Merging must retain payload markers such as
      // "\\ No newline at end of file" verbatim.
      currentHunk?.bodyLines.push(line);
    }
  }
  flushHunk();

  return {
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
    oldStartLine,
    newStartLine,
    stats: { additions, deletions },
    hunks,
  };
}

/**
 * Canonical unified-diff parser used by chat, simulator, and WorkStation.
 * Defaults preserve the legacy CodeBlock behavior.
 */
export function parseUnifiedDiff(
  diffText: string,
  options: ParseUnifiedDiffOptions = {}
): ParsedUnifiedDiff {
  const { hunks: _hunks, ...parsed } = parseUnifiedDiffInternal(
    diffText,
    options
  );
  return parsed;
}

/**
 * Compact old/new projection used by diff surfaces that do not want phantom
 * lines between hunks. Defaults preserve the former SessionCore behavior.
 */
export function parseUnifiedDiffToOldNew(
  diffText: string,
  options: ParseUnifiedDiffOptions = {}
): ParsedDiff {
  const { stats: _stats, ...parsed } = parseUnifiedDiff(diffText, {
    preserveHunkGaps: options.preserveHunkGaps ?? false,
    unprefixedBlankLine: options.unprefixedBlankLine ?? "ignore",
  });
  return parsed;
}

export function countUnifiedDiffLines(diffText: string): LineDiffStats {
  return parseUnifiedDiff(diffText, {
    preserveHunkGaps: false,
    unprefixedBlankLine: "ignore",
  }).stats;
}

/**
 * Merge diff hunks in edit order. Later overlapping hunks replace earlier
 * hunks, matching cumulative session-replay semantics.
 */
export function mergeUnifiedDiffStrings(diffs: readonly string[]): string {
  const allHunks = diffs.flatMap(
    (diff) =>
      parseUnifiedDiffInternal(diff, {
        preserveHunkGaps: false,
        unprefixedBlankLine: "ignore",
      }).hunks
  );

  if (allHunks.length === 0) return diffs.join("\n");

  const rangesOverlap = (left: ParsedHunk, right: ParsedHunk): boolean => {
    const leftEnd = left.oldStart + Math.max(left.oldCount, 1);
    const rightEnd = right.oldStart + Math.max(right.oldCount, 1);
    return left.oldStart < rightEnd && right.oldStart < leftEnd;
  };

  let merged: ParsedHunk[] = [];
  for (const hunk of allHunks) {
    merged = merged.filter((previous) => !rangesOverlap(previous, hunk));
    merged.push(hunk);
  }
  merged.sort((left, right) => left.oldStart - right.oldStart);

  return merged
    .flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      ...hunk.bodyLines,
    ])
    .join("\n");
}
