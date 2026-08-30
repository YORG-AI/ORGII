/**
 * Diff and Patch API
 *
 * High-performance diff computation and fuzzy patch application via Rust/Tauri.
 * Designed for AI code editing scenarios where patches may have line offset errors.
 *
 * NOTE: This module now uses the typed RPC layer (`@src/api/tauri/rpc`).
 * The RPC procedures handle snake_case → camelCase transform via snakeToCamel.
 */
import { rpc } from "@src/api/tauri/rpc";
import type * as DiffSchemas from "@src/api/tauri/rpc/schemas/diff";
import type { CamelCaseKeys } from "@src/api/tauri/rpc/transforms";

// ============================================
// Types (camelCase — public API)
// ============================================

export type DiffOptions = {
  algorithm?: "myers" | "patience" | "lcs";
  contextLines?: number;
  format?: "unified";
};

export type DiffStats = CamelCaseKeys<DiffSchemas.DiffStats>;
export type DiffResult = CamelCaseKeys<DiffSchemas.DiffResult>;

export interface HunkFailure {
  hunkIndex: number;
  expectedLine: number;
  reason: string;
}

export interface PatchResult {
  content: string;
  success: boolean;
  hunksApplied: number;
  hunksFailed: HunkFailure[];
  processingTimeUs: number;
}

export interface FuzzyPatchOptions {
  fuzzFactor?: number;
  minSimilarity?: number;
  ignoreWhitespace?: boolean;
}

export interface HunkResult {
  hunkIndex: number;
  offsetApplied: number;
  similarity: number;
  applied: boolean;
  reason?: string;
}

export interface FuzzyPatchResult {
  content: string;
  success: boolean;
  hunks: HunkResult[];
  processingTimeUs: number;
}

export interface MergeResult {
  content: string;
  clean: boolean;
  conflictCount: number;
  processingTimeUs: number;
}

// ============================================
// API Functions
// ============================================

/**
 * Compute diff between two texts
 *
 * @example
 * ```ts
 * const result = await computeDiff(originalCode, modifiedCode, {
 *   algorithm: "patience",
 *   contextLines: 5,
 *   oldLabel: "a/file.ts",
 *   newLabel: "b/file.ts",
 * });
 * ```
 */
export async function computeDiff(
  oldText: string,
  newText: string,
  options?: DiffOptions & { oldLabel?: string; newLabel?: string }
): Promise<DiffResult> {
  const raw = await rpc.diff.computeDiff({
    oldText,
    newText,
    oldLabel: options?.oldLabel,
    newLabel: options?.newLabel,
    options: options
      ? {
          algorithm: options.algorithm,
          context_lines: options.contextLines,
          format: options.format,
        }
      : undefined,
  });
  return raw as unknown as DiffResult;
}

/**
 * Apply patch exactly (no fuzzy matching)
 */
export async function applyPatch(
  original: string,
  patch: string
): Promise<PatchResult> {
  const raw = await rpc.diff.applyPatch({ original, patch });
  return raw as unknown as PatchResult;
}

/**
 * Apply patch with fuzzy matching (tolerates line offset errors)
 *
 * This is the key function for AI code editing scenarios where
 * the AI-generated patch may have incorrect line numbers.
 *
 * @example
 * ```ts
 * const result = await applyFuzzyPatch(originalCode, aiPatch, {
 *   fuzzFactor: 50,
 *   minSimilarity: 0.7,
 * });
 *
 * if (result.success) {
 *   editor.setValue(result.content);
 * }
 * ```
 */
export async function applyFuzzyPatch(
  original: string,
  patch: string,
  options?: FuzzyPatchOptions
): Promise<FuzzyPatchResult> {
  const raw = await rpc.diff.applyFuzzyPatch({
    original,
    patch,
    options: options
      ? {
          fuzz_factor: options.fuzzFactor,
          min_similarity: options.minSimilarity,
          ignore_whitespace: options.ignoreWhitespace,
        }
      : undefined,
  });
  return raw as unknown as FuzzyPatchResult;
}

/**
 * Three-way merge
 *
 * @example
 * ```ts
 * const result = await mergeThreeWay(baseContent, localContent, remoteContent, {
 *   ours: "local",
 *   theirs: "origin/main",
 * });
 *
 * if (result.clean) {
 *   await fs.writeFile(filePath, result.content);
 * } else {
 *   openConflictEditor(filePath, result);
 * }
 * ```
 */
export async function mergeThreeWay(
  base: string,
  ours: string,
  theirs: string,
  labels?: { ours?: string; theirs?: string }
): Promise<MergeResult> {
  const raw = await rpc.diff.mergeThreeWay({
    base,
    ours,
    theirs,
    oursLabel: labels?.ours,
    theirsLabel: labels?.theirs,
  });
  return raw as unknown as MergeResult;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Check if text is a unified diff
 */
export function isUnifiedDiff(text: string): boolean {
  if (!text) return false;
  const lines = text.split("\n", 10);
  return lines.some(
    (line) =>
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
  );
}

/**
 * Extract file path from unified diff header
 */
export function extractDiffFilePath(diff: string): string | null {
  const match = diff.match(/^---\s+a\/(.+)$/m);
  return match ? match[1] : null;
}

// ============================================
// Diff with Hunks (Combined API)
// ============================================

/** Hunk header info */
export interface DiffHunkHeader {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
}

/** A single diff line */
export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  index: number;
}

/** A diff hunk (group of changes with context) */
export interface DiffHunk {
  header: DiffHunkHeader;
  lines: DiffLine[];
  isExpanded: boolean;
  hunkIndex: number;
}

/** A cell in split diff view */
export interface SplitDiffCell {
  lineNumber?: number;
  content: string;
  type: "add" | "remove" | "context" | "empty" | "hunk-header";
  isSelected?: boolean;
}

/** A row in split diff view */
export interface SplitDiffRow {
  key: string;
  left: SplitDiffCell;
  right: SplitDiffCell;
  isHunkHeader?: boolean;
  hunkIndex?: number;
}

/** Statistics for the diff */
export interface DiffWithHunksStats {
  additions: number;
  deletions: number;
  totalChanges: number;
}

/** Result of compute_diff_with_hunks */
export interface DiffWithHunksResult {
  hunks: DiffHunk[];
  splitRows: SplitDiffRow[];
  stats: DiffWithHunksStats;
  maxLineNumber: number;
}

/**
 * Compute diff with hunks and split rows in one call.
 *
 * This replaces the pattern of:
 * 1. compute_structured_diff (Rust)
 * 2. groupIntoHunks (JS)
 * 3. generateSplitRows (JS)
 *
 * By doing all three in Rust, we eliminate multiple IPC round-trips
 * and JS processing overhead for large diffs.
 *
 * @param oldText Original text
 * @param newText Modified text
 * @param contextLines Number of context lines around changes (default: 3)
 * @returns Hunks, split rows, and stats
 */
export async function computeDiffWithHunks(
  oldText: string,
  newText: string,
  contextLines?: number
): Promise<DiffWithHunksResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DiffWithHunksResult>("compute_diff_with_hunks", {
    oldText,
    newText,
    contextLines: contextLines ?? null,
  });
}
