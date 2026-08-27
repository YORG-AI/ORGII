/**
 * ModernDiff Utilities
 *
 * Shared utility functions for diff computation and rendering
 */
import { invoke } from "@tauri-apps/api/core";

import type { DiffLine } from "./types";

// Diff Algorithm (via Rust `similar` crate)

/**
 * Compute structured diff using Rust `similar` (Myers algorithm).
 * Replaces the O(n^2) JS LCS implementation.
 */
export async function computeDiffAsync(
  oldValue: string,
  newValue: string,
  contextLines: number,
  collapseUnchanged: boolean,
  oldStartLine = 1,
  newStartLine = 1
): Promise<DiffLine[]> {
  const rawDiff: DiffLine[] = await invoke("compute_structured_diff", {
    oldText: oldValue,
    newText: newValue,
    oldStartLine,
    newStartLine,
  });

  if (!collapseUnchanged) {
    return rawDiff;
  }

  return collapseContextLines(rawDiff, contextLines);
}

export const collapseContextLines = (
  lines: DiffLine[],
  contextLines: number
): DiffLine[] => {
  const result: DiffLine[] = [];
  const minCollapse = 4;

  // Find all change indices
  const changeIndices: number[] = [];
  lines.forEach((line, idx) => {
    if (line.type === "add" || line.type === "remove") {
      changeIndices.push(idx);
    }
  });

  if (changeIndices.length === 0) {
    if (lines.length > minCollapse + contextLines * 2) {
      result.push(...lines.slice(0, contextLines));
      result.push({
        type: "collapse",
        content: "",
        collapsedCount: lines.length - contextLines * 2,
        collapsedLines: lines.slice(contextLines, -contextLines),
        collapsePosition: "middle",
      });
      result.push(...lines.slice(-contextLines));
    } else {
      return lines;
    }
    return result;
  }

  // Build visibility set
  const visible = new Set<number>();
  changeIndices.forEach((idx) => {
    for (
      let contextIndex = Math.max(0, idx - contextLines);
      contextIndex <= Math.min(lines.length - 1, idx + contextLines);
      contextIndex++
    ) {
      visible.add(contextIndex);
    }
  });

  let idx = 0;
  while (idx < lines.length) {
    if (visible.has(idx)) {
      result.push(lines[idx]);
      idx++;
    } else {
      const start = idx;
      while (idx < lines.length && !visible.has(idx)) {
        idx++;
      }
      const collapsedLines = lines.slice(start, idx);
      if (collapsedLines.length >= minCollapse) {
        // Determine collapse position
        const isStart = start === 0;
        const isEnd = idx === lines.length;
        const collapsePosition = isStart ? "start" : isEnd ? "end" : "middle";

        result.push({
          type: "collapse",
          content: "",
          collapsedCount: collapsedLines.length,
          collapsedLines,
          collapsePosition,
        });
      } else {
        result.push(...collapsedLines);
      }
    }
  }

  return result;
};
