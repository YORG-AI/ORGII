/**
 * Utilities for collapsing unchanged lines in split view
 */
import { MIN_COLLAPSE_LINES } from "../config";
import type { AlignedLine, DisplayLine } from "../types";

/**
 * Collapse unchanged lines in split view, keeping context around changes
 */
export function collapseSplitViewLines(
  lines: AlignedLine[],
  contextLines: number
): DisplayLine[] {
  const result: DisplayLine[] = [];

  // Find all change indices
  const changeIndices: number[] = [];
  lines.forEach((line, idx) => {
    const hasChange =
      line.oldLine?.type === "remove" || line.newLine?.type === "add";
    if (hasChange) {
      changeIndices.push(idx);
    }
  });

  // If no changes, collapse most of the file
  if (changeIndices.length === 0) {
    if (lines.length > MIN_COLLAPSE_LINES + contextLines * 2) {
      result.push(...lines.slice(0, contextLines));
      result.push({
        type: "collapse",
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

  // Build visibility set - lines that should be shown
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

  // Build result with collapse sections
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
      if (collapsedLines.length >= MIN_COLLAPSE_LINES) {
        // Determine collapse position
        const isStart = start === 0;
        const isEnd = idx === lines.length;
        const collapsePosition = isStart ? "start" : isEnd ? "end" : "middle";

        result.push({
          type: "collapse",
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
}
