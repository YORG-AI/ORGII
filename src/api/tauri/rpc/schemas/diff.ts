/**
 * Zod schemas for diff/patch Tauri commands.
 *
 * Mirrors Rust types in src-tauri/src/perf/ diff module.
 */
import { z } from "zod/v4";

// ============================================================================
// Value objects
// ============================================================================

export const DiffAlgorithmSchema = z.union([
  z.literal("myers"),
  z.literal("patience"),
  z.literal("lcs"),
]);

export const DiffOptionsSchema = z.object({
  algorithm: DiffAlgorithmSchema.optional(),
  context_lines: z.number().optional(),
  format: z.literal("unified").optional(),
});

export const DiffStatsSchema = z.object({
  lines_added: z.number(),
  lines_removed: z.number(),
  lines_unchanged: z.number(),
  hunks: z.number(),
});

export const DiffResultSchema = z.object({
  diff: z.string(),
  stats: DiffStatsSchema,
  processing_time_us: z.number(),
});

export const HunkFailureSchema = z.object({
  hunk_index: z.number(),
  expected_line: z.number(),
  reason: z.string(),
});

export const PatchResultSchema = z.object({
  content: z.string(),
  success: z.boolean(),
  hunks_applied: z.number(),
  hunks_failed: z.array(HunkFailureSchema),
  processing_time_us: z.number(),
});

export const FuzzyPatchOptionsSchema = z.object({
  fuzz_factor: z.number().optional(),
  min_similarity: z.number().optional(),
  ignore_whitespace: z.boolean().optional(),
});

export const HunkResultSchema = z.object({
  hunk_index: z.number(),
  offset_applied: z.number(),
  similarity: z.number(),
  applied: z.boolean(),
  reason: z.string().nullable(),
});

export const FuzzyPatchResultSchema = z.object({
  content: z.string(),
  success: z.boolean(),
  hunks: z.array(HunkResultSchema),
  processing_time_us: z.number(),
});

export const MergeResultSchema = z.object({
  content: z.string(),
  clean: z.boolean(),
  conflict_count: z.number(),
  processing_time_us: z.number(),
});

// ============================================================================
// Procedure inputs
// ============================================================================

export const ComputeDiffInput = z.object({
  oldText: z.string(),
  newText: z.string(),
  oldLabel: z.string().optional(),
  newLabel: z.string().optional(),
  options: DiffOptionsSchema.optional(),
});

export const ApplyPatchInput = z.object({
  original: z.string(),
  patch: z.string(),
});

export const ApplyFuzzyPatchInput = z.object({
  original: z.string(),
  patch: z.string(),
  options: FuzzyPatchOptionsSchema.optional(),
});

export const MergeThreeWayInput = z.object({
  base: z.string(),
  ours: z.string(),
  theirs: z.string(),
  oursLabel: z.string().optional(),
  theirsLabel: z.string().optional(),
});

// ============================================================================
// Static types
// ============================================================================

export type DiffStats = z.infer<typeof DiffStatsSchema>;

export type MergeResult = z.infer<typeof MergeResultSchema>;
