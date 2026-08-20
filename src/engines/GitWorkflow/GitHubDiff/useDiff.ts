/**
 * useDiff Hook
 *
 * Computes diff between two strings using Rust `similar` crate (Myers algorithm).
 * All heavy lifting (diff computation, hunk grouping, split row generation) is
 * done in Rust via a single `compute_diff_with_hunks` command.
 *
 * Features:
 * - Rust-powered Myers diff algorithm via `similar` crate
 * - Hunk grouping with context lines (Rust)
 * - Split view row generation (Rust)
 * - Single IPC call for entire pipeline
 * - Async with loading/error state
 */
import type {
  FileDiff,
  UseDiffOptions,
  UseDiffReturn,
} from "@/src/engines/GitWorkflow/GitHubDiff/types";
import { useEffect, useMemo, useState } from "react";

import type {
  DiffHunk,
  DiffWithHunksResult,
  SplitDiffRow,
} from "@src/api/tauri/diff";
import { computeDiffWithHunks } from "@src/api/tauri/diff";

export type { DiffHunk, SplitDiffRow, UseDiffReturn };

const DEFAULT_CONTEXT_LINES = 3;

// ============================================
// Main Hook
// ============================================

export function useDiff(options: UseDiffOptions): UseDiffReturn {
  const {
    oldValue,
    newValue,
    contextLines = DEFAULT_CONTEXT_LINES,
    hideWhitespace = false,
  } = options;

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiffWithHunksResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    const compute = async () => {
      setLoading(true);
      setError(null);

      try {
        let oldText = oldValue;
        let newText = newValue;

        if (hideWhitespace) {
          oldText = oldText.replace(/[ \t]+$/gm, "");
          newText = newText.replace(/[ \t]+$/gm, "");
        }

        // Single Rust call handles: diff + hunk grouping + split rows
        const rustResult = await computeDiffWithHunks(
          oldText,
          newText,
          contextLines
        );

        if (cancelled) return;

        setResult(rustResult);

        // Convert Rust result to FileDiff format for compatibility
        const fileDiff: FileDiff = {
          type: "text",
          path: "",
          hunks: rustResult.hunks.map((hunk) => ({
            header: hunk.header,
            lines: hunk.lines.map((line) => ({
              type: line.type as "add" | "remove" | "context",
              content: line.content,
              oldLineNumber: line.oldLineNumber,
              newLineNumber: line.newLineNumber,
            })),
            isExpanded: hunk.isExpanded,
            hunkIndex: hunk.hunkIndex,
          })),
          isBinary: false,
          isTooLarge: false,
          maxLineNumber: rustResult.maxLineNumber,
          stats: {
            additions: rustResult.stats.additions,
            deletions: rustResult.stats.deletions,
          },
        };

        if (!cancelled) {
          setDiff(fileDiff);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    compute();
    return () => {
      cancelled = true;
    };
  }, [oldValue, newValue, contextLines, hideWhitespace]);

  // Split rows come directly from Rust now
  const splitRows = useMemo<SplitDiffRow[]>(() => {
    if (!result) return [];
    // Map Rust cell_type to frontend type
    return result.splitRows.map((row) => ({
      ...row,
      left: {
        ...row.left,
        type: row.left.type as
          | "add"
          | "remove"
          | "context"
          | "empty"
          | "hunk-header",
      },
      right: {
        ...row.right,
        type: row.right.type as
          | "add"
          | "remove"
          | "context"
          | "empty"
          | "hunk-header",
      },
    }));
  }, [result]);

  const stats = useMemo(() => {
    if (!result) {
      return { additions: 0, deletions: 0, totalChanges: 0 };
    }
    return {
      additions: result.stats.additions,
      deletions: result.stats.deletions,
      totalChanges: result.stats.totalChanges,
    };
  }, [result]);

  return {
    diff,
    loading,
    error,
    splitRows,
    stats,
  };
}

export default useDiff;
