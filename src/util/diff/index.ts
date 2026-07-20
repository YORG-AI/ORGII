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

export {
  countUnifiedDiffLines,
  mergeUnifiedDiffStrings,
  parseUnifiedDiff,
  parseUnifiedDiffToOldNew,
  type ParsedDiff,
  type ParseUnifiedDiffOptions,
} from "./unifiedDiff";
export {
  countContentLines,
  resolveLineDiffStats,
  type ResolveLineDiffStatsOptions,
} from "./lineStats";
export type { LineDiffStats } from "./types";
