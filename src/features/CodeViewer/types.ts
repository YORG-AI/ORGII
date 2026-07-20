/**
 * Type definitions for ModernSplitDiff component
 */
import type { LineDiffStats } from "@src/util/diff/types";

export interface ModernSplitDiffProps {
  /** Original/old content */
  oldValue: string;
  /** Modified/new content */
  newValue: string;
  /** File path for display */
  filePath?: string;
  /** Container height */
  height?: number | string;
  /** Container width */
  width?: number | string;
  /** Read-only mode */
  readOnly?: boolean;
  /** Disable wrapper styling (background, border, radius) for embedded use */
  noWrapper?: boolean;
  /** Enable cherry-picking mode for selecting individual lines */
  cherrypicking?: boolean;
  /** Callback when selected lines change (line indices) */
  onSelectionChange?: (selectedLines: Set<number>) => void;
  /** Initial selected lines */
  initialSelection?: Set<number>;
  /** Number of context lines around changes */
  contextLines?: number;
  /** Collapse unchanged regions */
  collapseUnchanged?: boolean;
  /** Show file path in header (legacy property) */
  showFilePath?: boolean;
  /** Show stats bar (legacy property) */
  showStatsBar?: boolean;
  /** Show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Enable internal scrolling (default: true). Set to false for embedded contexts like chat. */
  internalScroll?: boolean;
  /** Allow expanding collapsed sections (default: true). Set to false for read-only chat views. */
  allowExpand?: boolean;
  /** Style for change indicators: "icon" shows +/- icons, "border" shows colored left border (default: "icon") */
  indicatorStyle?: "icon" | "border";
  /** Starting line number for old content (default: 1). Use this when showing a hunk instead of full file. */
  oldStartLine?: number;
  /** Starting line number for new content (default: 1). Use this when showing a hunk instead of full file. */
  newStartLine?: number;
  className?: string;
}

export interface AlignedLine {
  oldLine?: { number: number; content: string; type: "remove" | "context" };
  newLine?: { number: number; content: string; type: "add" | "context" };
  index: number; // Original index for selection tracking
}

export interface CollapsedSection {
  type: "collapse";
  collapsedCount: number;
  collapsedLines: AlignedLine[];
  collapsePosition: "start" | "middle" | "end";
}

export type DisplayLine = AlignedLine | CollapsedSection;

export interface ChangeRange {
  startIndex: number;
  lineIndices: number[];
}

export type DiffStats = LineDiffStats;

export interface ChangeableIndices {
  oldIndices: number[];
  newIndices: number[];
  allIndices: number[];
}

export interface DiffLine {
  type: "add" | "remove" | "context" | "collapse";
  content?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  collapsedCount?: number;
  index?: number;
  collapsedLines?: DiffLine[];
  collapsePosition?: "start" | "middle" | "end";
}

export type ModernDiffProps = ModernSplitDiffProps;
