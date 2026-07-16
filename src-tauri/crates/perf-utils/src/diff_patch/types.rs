//! Types for the diff/patch infrastructure
//!
//! Covers: `DiffOptions`, `DiffLine`, `StructuredDiff`, `ParsedHunk`,
//! `HunkResult`, and `PatchConversionResult` — all used by the diff engine
//! and its Tauri command surface.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DiffOptions {
    /// Diff algorithm: "myers" (default), "patience", "lcs"
    pub algorithm: Option<String>,
    /// Context lines around changes (default: 3)
    pub context_lines: Option<usize>,
    /// Output format: "unified" (default)
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffResult {
    /// Unified diff string
    pub diff: String,
    /// Statistics
    pub stats: PatchDiffStats,
    /// Processing time in microseconds
    pub processing_time_us: f64,
}

/// Statistics for text diff/patch operations
#[derive(Debug, Clone, Serialize)]
pub struct PatchDiffStats {
    pub lines_added: usize,
    pub lines_removed: usize,
    pub lines_unchanged: usize,
    pub hunks: usize,
}

// ============================================
// Types - Patch
// ============================================

#[derive(Debug, Clone, Serialize)]
pub struct PatchResult {
    /// Patched content
    pub content: String,
    /// Whether patch was applied successfully
    pub success: bool,
    /// Applied hunks count
    pub hunks_applied: usize,
    /// Failed hunks (with reasons)
    pub hunks_failed: Vec<HunkFailure>,
    /// Processing time
    pub processing_time_us: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HunkFailure {
    pub hunk_index: usize,
    pub expected_line: usize,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FuzzyPatchOptions {
    /// Maximum line offset to search (default: 100)
    pub fuzz_factor: Option<usize>,
    /// Minimum similarity ratio to accept (0.0-1.0, default: 0.6)
    pub min_similarity: Option<f64>,
    /// Allow whitespace-only differences
    pub ignore_whitespace: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FuzzyPatchResult {
    /// Patched content
    pub content: String,
    /// Whether all hunks were applied
    pub success: bool,
    /// Detailed results per hunk
    pub hunks: Vec<HunkResult>,
    /// Processing time
    pub processing_time_us: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HunkResult {
    pub hunk_index: usize,
    /// Offset used to apply this hunk (0 = exact match)
    pub offset_applied: i32,
    /// Similarity score (1.0 = exact match)
    pub similarity: f64,
    pub applied: bool,
    pub reason: Option<String>,
}

// ============================================
// Types - Merge
// ============================================

#[derive(Debug, Clone, Serialize)]
pub struct TextMergeResult {
    /// Merged content (with conflict markers if conflicts exist)
    pub content: String,
    /// Whether merge was clean (no conflicts)
    pub clean: bool,
    /// Number of conflicts
    pub conflict_count: usize,
    /// Processing time
    pub processing_time_us: f64,
}

// ============================================
// Types - Structured Diff (for CodeViewer)
// ============================================

/// A single diff line matching the frontend `DiffLine` type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDiffLine {
    #[serde(rename = "type")]
    pub line_type: &'static str,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line_number: Option<usize>,
    pub index: usize,
}

/// A single aligned line pair for split-view diff.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedDiffLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<AlignedSide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<AlignedSide>,
    pub index: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlignedSide {
    pub number: usize,
    pub content: String,
    #[serde(rename = "type")]
    pub side_type: &'static str,
}

// ============================================
// Types - Dirty Diff (for CodeMirror gutter)
// ============================================

/// Line change type for dirty diff gutter
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DirtyDiffLineType {
    Added,
    Modified,
    Deleted,
}

/// A line change for dirty diff gutter
#[derive(Debug, Clone, Serialize)]
pub struct DirtyDiffMarker {
    /// Line number (1-based)
    pub line: usize,
    /// Type of change
    #[serde(rename = "type")]
    pub change_type: DirtyDiffLineType,
}

/// Result of dirty diff computation
#[derive(Debug, Clone, Serialize)]
pub struct DirtyDiffResult {
    /// List of changed lines
    pub markers: Vec<DirtyDiffMarker>,
    /// Processing time in microseconds
    pub processing_time_us: f64,
}

// ============================================
// Types - Patch Conversion
// ============================================

/// One `*** Add File:` / `*** Modify File:` / `*** Delete File:` section within a patch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSegment {
    pub file_path: String,
    pub diff: String,
    pub lines_added: usize,
    pub lines_removed: usize,
    pub is_deleted: bool,
    /// True when the source patch supplied a numeric `@@ -N +M @@` hunk range.
    /// Synthetic ranges keep the unified diff renderable but should not be
    /// treated as authoritative line metadata.
    pub has_explicit_hunk_header: bool,
}

/// Result of converting a "*** Begin Patch" format to unified diff.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchConversionResult {
    pub diff: String,
    pub lines_added: usize,
    pub lines_removed: usize,
    pub file_paths: Vec<String>,
    pub segments: Vec<PatchSegment>,
}

// ============================================
// Types - Diff with Hunks (for useDiff)
// ============================================

/// Hunk header for structured diff (frontend `DiffHunkHeader` type).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDiffHunkHeader {
    pub old_start_line: usize,
    pub old_line_count: usize,
    pub new_start_line: usize,
    pub new_line_count: usize,
}

/// A structured diff hunk for frontend rendering (matches `DiffHunk` type).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDiffHunk {
    pub header: StructuredDiffHunkHeader,
    pub lines: Vec<StructuredDiffLine>,
    pub is_expanded: bool,
    pub hunk_index: usize,
}

/// A cell in split diff view matching frontend `SplitDiffCell` type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitDiffCell {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<usize>,
    pub content: String,
    #[serde(rename = "type")]
    pub cell_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_selected: Option<bool>,
}

/// A row in split diff view matching frontend `SplitDiffRow` type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitDiffRow {
    pub key: String,
    pub left: SplitDiffCell,
    pub right: SplitDiffCell,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hunk_header: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunk_index: Option<usize>,
}

/// Statistics for diff with hunks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffWithHunksStats {
    pub additions: usize,
    pub deletions: usize,
    pub total_changes: usize,
}

/// Result of compute_diff_with_hunks - contains everything the frontend needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffWithHunksResult {
    pub hunks: Vec<StructuredDiffHunk>,
    pub split_rows: Vec<SplitDiffRow>,
    pub stats: DiffWithHunksStats,
    pub max_line_number: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffNormalization {
    pub old_content: String,
    pub new_content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_start_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_start_line: Option<usize>,
    pub lines_added: usize,
    pub lines_removed: usize,
}

// ============================================
// Internal Types
// ============================================

#[derive(Debug, Clone)]
pub(crate) struct ParsedHunk {
    /// Original starting line (1-indexed)
    pub old_start: usize,
    /// Lines in the hunk (with prefixes: ' ', '-', '+')
    pub lines: Vec<String>,
}
