/**
 * GitHubDiff Types
 *
 * Type definitions for the diff viewer architecture.
 */
import type { DiffViewMode } from "@src/types/git/types";

// ============================================
// Diff Line Types
// ============================================

/** The type of a diff line */
export type DiffLineType = "add" | "remove" | "context" | "hunk-header";

/** Represents a single line in a diff */
export interface DiffLine {
  /** The type of change for this line */
  type: DiffLineType;
  /** The content of the line (without the +/- prefix) */
  content: string;
  /** Line number in the old file (undefined for additions) */
  oldLineNumber?: number;
  /** Line number in the new file (undefined for deletions) */
  newLineNumber?: number;
  /** Whether this line is selected (for staging) */
  isSelected?: boolean;
  /** Whether this line has trailing whitespace issues */
  noTrailingNewLine?: boolean;
}

// ============================================
// Diff Hunk Types
// ============================================

/** Represents a hunk header like @@ -1,3 +1,4 @@ */
export interface DiffHunkHeader {
  /** Start line in old file */
  oldStartLine: number;
  /** Number of lines in old file */
  oldLineCount: number;
  /** Start line in new file */
  newStartLine: number;
  /** Number of lines in new file */
  newLineCount: number;
  /** Optional section heading (function name, etc.) */
  sectionHeading?: string;
}

/** Represents a diff hunk (a contiguous set of changes) */
export interface DiffHunk {
  /** The hunk header information */
  header: DiffHunkHeader;
  /** The lines in this hunk */
  lines: DiffLine[];
  /** Whether this hunk is expanded */
  isExpanded?: boolean;
  /** Index of this hunk in the diff */
  hunkIndex: number;
}

// ============================================
// Diff Data Types
// ============================================

/** The kind of change for a file */
export type DiffType =
  | "text"
  | "binary"
  | "image"
  | "large"
  | "unrenderable"
  | "submodule";

/** Represents a complete file diff */
export interface FileDiff {
  /** The type of diff */
  type: DiffType;
  /** File path */
  path: string;
  /** Old file path (for renames) */
  oldPath?: string;
  /** The hunks in this diff */
  hunks: DiffHunk[];
  /** Whether the file is binary */
  isBinary: boolean;
  /** Whether the file is too large to display */
  isTooLarge: boolean;
  /** Maximum line number (for gutter width calculation) */
  maxLineNumber: number;
  /** Statistics */
  stats: {
    additions: number;
    deletions: number;
  };
}

// ============================================
// View Mode Types
// ============================================

/** The view mode for the diff */
export type { DiffViewMode } from "@src/types/git/types";

/** Expansion type for hunks */
export type DiffHunkExpansionType = "up" | "down" | "short" | "full";

// ============================================
// Row Types for Split View
// ============================================

/** Data for a single cell in split view */
export interface SplitDiffCell {
  /** Line number (if applicable) */
  lineNumber?: number;
  /** Content of the cell */
  content: string;
  /** Type of change */
  type: DiffLineType | "empty";
  /** Whether this cell is selected */
  isSelected?: boolean;
}

/** A row in the split diff view */
export interface SplitDiffRow {
  /** Unique key for React */
  key: string;
  /** Left side (old file) */
  left: SplitDiffCell;
  /** Right side (new file) */
  right: SplitDiffCell;
  /** Whether this is a hunk header row */
  isHunkHeader?: boolean;
  /** Hunk index for expansion */
  hunkIndex?: number;
}

// ============================================
// Component Props Types
// ============================================

/** Props for the main GitHubDiff component */
export interface GitHubDiffProps {
  /** Original/old content */
  oldValue: string;
  /** Modified/new content */
  newValue: string;
  /** File path for display and language detection */
  filePath?: string;
  /** Container height */
  height?: number | string;
  /** Container width */
  width?: number | string;
  /** View mode: unified or split */
  viewMode?: DiffViewMode;
  /** Number of context lines around changes */
  contextLines?: number;
  /** Whether to show line numbers */
  showLineNumbers?: boolean;
  /** Whether to enable syntax highlighting */
  syntaxHighlighting?: boolean;
  /** Whether diff is read-only */
  readOnly?: boolean;
  /** Whether to hide whitespace changes */
  hideWhitespaceChanges?: boolean;
  /** Whether to show hunk headers */
  showHunkHeaders?: boolean;
  /** Callback when a line is clicked */
  onLineClick?: (line: DiffLine, hunkIndex: number) => void;
  /** Callback when a hunk is expanded/collapsed */
  onHunkToggle?: (hunkIndex: number, expanded: boolean) => void;
  /** Custom class name */
  className?: string;
}

/** Props for diff row component */
export interface DiffRowProps {
  /** The line data */
  line: DiffLine;
  /** The language for syntax highlighting */
  language?: string;
  /** Whether this row is highlighted/active */
  isHighlighted?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Maximum line number for gutter width */
  maxLineNumber?: number;
}

/** Props for split diff row component */
export interface SplitDiffRowProps {
  /** The row data */
  row: SplitDiffRow;
  /** The language for syntax highlighting */
  language?: string;
  /** Whether this row is highlighted/active */
  isHighlighted?: boolean;
  /** Click handler for left side */
  onLeftClick?: () => void;
  /** Click handler for right side */
  onRightClick?: () => void;
  /** Maximum line number for gutter width */
  maxLineNumber?: number;
}

// ============================================
// Hook Types
// ============================================

/** Options for useDiff hook */
export interface UseDiffOptions {
  /** Original content */
  oldValue: string;
  /** New content */
  newValue: string;
  /** Number of context lines */
  contextLines?: number;
  /** Whether to hide whitespace changes */
  hideWhitespace?: boolean;
}

/** Return type for useDiff hook */
export interface UseDiffReturn {
  /** The computed diff */
  diff: FileDiff | null;
  /** Whether diff is being computed */
  loading: boolean;
  /** Error if any */
  error: string | null;
  /** Split view rows (computed from hunks) */
  splitRows: SplitDiffRow[];
  /** Statistics */
  stats: {
    additions: number;
    deletions: number;
    totalChanges: number;
  };
}
