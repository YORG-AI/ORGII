/**
 * SimulatorIDE Types
 *
 * Consolidated types for the combined IDE view in simulator.
 * Extends SimulatorAppBaseState for framework integration.
 * Uses SessionEvent from session store (SINGLE SOURCE OF TRUTH).
 */
import type { ReactNode } from "react";

import type {
  SessionEvent,
  ShellReplayRef,
  ShellReplayState,
} from "@src/engines/SessionCore/core/types";
import type { RawEventInput } from "@src/engines/SessionCore/rendering/props";
import type { SimulatorAppBaseState } from "@src/engines/Simulator/apps/core/types";

// ============================================
// File Operation Types
// ============================================

export type FileOperationType = "read" | "write" | "delete";

export const FILE_OPERATION_TYPE: Record<
  Uppercase<FileOperationType>,
  FileOperationType
> = {
  READ: "read",
  WRITE: "write",
  DELETE: "delete",
};

export interface FileOperationEntry {
  /** File path */
  filePath: string;
  /** File name only */
  fileName: string;
  /** Directory path */
  directory: string;
  /** Operation type */
  type: FileOperationType;
  /** Whether still loading */
  isLoading?: boolean;
  /** Whether the tool call itself failed (displayStatus === "failed") */
  isFailed?: boolean;
  /** Original event */
  event: SessionEvent;
  /** Event ID (primary - for current op, or latest if consolidated) */
  eventId: string;
  /** Whether this is the triggering event (current) */
  isCurrent: boolean;
  /** For write operations: lines added */
  linesAdded?: number;
  /** For write operations: lines removed */
  linesRemoved?: number;
  /** File content (for reads) */
  content?: string;
  /** 1-indexed first line of a ranged read (offset/limit); 1 or absent = from top. */
  contentStartLine?: number;
  /** Old content (for writes) */
  oldContent?: string;
  /** New content (for writes) */
  newContent?: string;
  /** Unified diff for write operations when available. */
  diff?: string;
  /** Starting line number for the old side when rendering a diff hunk. */
  oldStartLine?: number;
  /** Starting line number for the new side when rendering a diff hunk. */
  newStartLine?: number;
  /**
   * Write-only: whether a baseline (old) snapshot existed before the edit.
   * Preserved when large payloads are stripped for memory; used for M vs U badge.
   */
  writeHasBaselineContent?: boolean;
  /** Language for syntax highlighting */
  language?: string;
  /** All related event IDs (when consolidated from multiple edits) */
  relatedEventIds?: string[];
  /** Number of edits consolidated (for display) */
  editCount?: number;
  /** All related operations (for combined diff rendering) */
  relatedOperations?: FileOperationEntry[];
}

export interface CurrentFileData {
  filePath: string;
  fileName: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  diff?: string;
  oldStartLine?: number;
  newStartLine?: number;
  language?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

// ============================================
// Shell Operation Types
// ============================================

export interface ShellOperationEntry {
  /** Full command */
  command: string;
  /** Short command for display (first part) */
  shortCommand: string;
  /** Command keywords (cd, ls, etc.) */
  commandKeywords: string;
  /** Working directory */
  cwd?: string;
  /** Agent-provided human summary */
  description?: string;
  /** Command output (final, after completion) */
  output?: string;
  /** Live streaming output while command is running */
  streamOutput?: string;
  /** Stable identity for the durable shell replay artifact. */
  replayRef?: ShellReplayRef;
  /**
   * Visibility state resolved from the current playback cursor. This must not
   * be sourced from a mutable latest shell row while replaying history.
   */
  replayState?: ShellReplayState;
  /** Event cursor that supplied replayState; used to invalidate async loads. */
  replayCursorEventId?: string;
  /** Exit code */
  exitCode?: number;
  /** Execution time in ms */
  executionTime?: number;
  /** Whether command is still running */
  isLoading?: boolean;
  /** Whether command failed */
  isError?: boolean;
  /** Whether the tool call itself failed (displayStatus === "failed") */
  isFailed?: boolean;
  /** Original event */
  event: SessionEvent;
  /** Event ID */
  eventId: string;
  /** Is this the current event */
  isCurrent: boolean;
  /** Custom output component to render instead of plain text */
  customOutputComponent?: ReactNode;
}

export interface CurrentShellData {
  command: string;
  shortCommand?: string;
  commandKeywords?: string;
  description?: string;
  output?: string;
  exitCode?: number;
  cwd?: string;
  executionTime?: number;
  isLoading?: boolean;
  isError?: boolean;
  /** Custom output component to render instead of plain text (e.g., for structured ls output) */
  customOutputComponent?: ReactNode;
}

// ============================================
// Explore Operation Types
// ============================================

/** Search result from code_search/grep */
export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

/** Explore operation types */
export type ExploreType =
  | "code_search"
  | "glob"
  | "file_search"
  | "list_dir"
  | "tool_search"
  | "cat"
  | "manage_workspace"
  | "query_lsp";

export const EXPLORE_TYPE: Record<Uppercase<ExploreType>, ExploreType> = {
  CODE_SEARCH: "code_search",
  GLOB: "glob",
  FILE_SEARCH: "file_search",
  LIST_DIR: "list_dir",
  TOOL_SEARCH: "tool_search",
  CAT: "cat",
  MANAGE_WORKSPACE: "manage_workspace",
  QUERY_LSP: "query_lsp",
};

/** Explore operation entry */
export interface ExploreOperationEntry {
  /** Search query/pattern, command, or tool-search query */
  query: string;
  /** Explore type */
  exploreType: ExploreType;
  /** Specific action for multi-action explore tools, e.g. code_search grep/find_files. */
  exploreAction?: string;
  /** Results found (for code_search, grep) */
  results: SearchResult[];
  /** File/directory results (for glob, list_dir) */
  files?: string[];
  /** Total matches */
  totalMatches: number;
  /** Whether a result payload has arrived for this operation. */
  hasResultPayload?: boolean;
  /** Target directory */
  directory?: string;
  /** Original event */
  event: SessionEvent;
  /** Event ID */
  eventId: string;
  /** Is this the current event */
  isCurrent: boolean;
  /** Whether still loading */
  isLoading?: boolean;
  /** Whether the tool call itself failed (displayStatus === "failed") */
  isFailed?: boolean;
  /** True when fewer rows are shown than were parsed (display cap or parse safety cap). */
  listDirDisplayTruncated?: boolean;
  /** Entries parsed before applying the display cap (≤ parse safety cap). */
  listDirTotalListedCount?: number;
  /** True when parsing stopped at SIMULATOR_LIST_DIR_PARSE_SAFETY_CAP. */
  listDirParseSafetyCapped?: boolean;
}

/** Tool operation entry (for MCP and other uncategorized tools) */
export interface ToolOperationEntry {
  /** Tool/function name */
  toolName: string;
  /** Display name */
  displayName: string;
  /** Original event */
  event: SessionEvent;
  /** Event ID */
  eventId: string;
  /** Is this the current event */
  isCurrent: boolean;
  /** Whether still loading */
  isLoading?: boolean;
  /** Whether the tool call itself failed */
  isFailed?: boolean;
}

// ============================================
// IDE State (extends SimulatorAppBaseState)
// ============================================

/** File panel view modes: explore (read + search), write, terminal, or tool (other tools) */
export type FilePanelViewMode = "explore" | "write" | "terminal" | "tool";

export const FILE_PANEL_VIEW_MODE: Record<
  Uppercase<FilePanelViewMode>,
  FilePanelViewMode
> = {
  EXPLORE: "explore",
  WRITE: "write",
  TERMINAL: "terminal",
  TOOL: "tool",
};

/**
 * IDE-specific state extending the base simulator app state.
 * Contains all file, shell, and search operations up to the current replay point.
 */
export interface SimulatorIDEState extends SimulatorAppBaseState {
  /** All file operations (read + write) up to current point */
  fileOperations: FileOperationEntry[];
  /** All shell operations up to current point */
  shellOperations: ShellOperationEntry[];
  /** All explore operations up to current point */
  exploreOperations: ExploreOperationEntry[];
  /** All tool operations up to current point */
  toolOperations: ToolOperationEntry[];
  /** Currently selected file operation */
  selectedFileOperation: FileOperationEntry | null;
  /** Currently selected shell operation */
  selectedShellOperation: ShellOperationEntry | null;
  /** Currently selected explore operation */
  selectedExploreOperation: ExploreOperationEntry | null;
  /** Currently selected tool operation */
  selectedToolOperation: ToolOperationEntry | null;
  /** File panel view mode: show reads, writes, or searches */
  fileViewMode: FilePanelViewMode;
}

// ============================================
// SimulatorIDE Component Types
// ============================================

export type SimulatorIDETab = "code" | "terminal";

export type CodePanelMode = "file" | "explore" | "terminal" | "tool";
export const CODE_PANEL_MODE: Record<
  Uppercase<CodePanelMode>,
  CodePanelMode
> = {
  FILE: "file",
  EXPLORE: "explore",
  TERMINAL: "terminal",
  TOOL: "tool",
};

/** Current event type for the IDE */
export type IDEEventType = "read" | "write" | "shell" | "explore" | "tool";

export const IDE_EVENT_TYPE: Record<Uppercase<IDEEventType>, IDEEventType> = {
  READ: "read",
  WRITE: "write",
  SHELL: "shell",
  EXPLORE: "explore",
  TOOL: "tool",
};

export interface SimulatorIDEProps {
  currentEvent: RawEventInput;
  /** Type of current event */
  currentEventType: IDEEventType;
  /** Current file data (for read/write events) */
  currentFileData?: CurrentFileData;
  /** Current shell data (for shell events) */
  currentShellData?: CurrentShellData;
  /** Component mode */
  mode?: "interactive" | "simulation";
}

export interface UseSimulatorIDEOptions {
  currentEventId: string;
  currentEventType: IDEEventType;
  currentEvent?: SessionEvent | null;
  currentFileData?: CurrentFileData;
  currentShellData?: CurrentShellData;
}

// ============================================
// IDE Event Matching
// ============================================

/**
 * Note: IDE event matching uses Rust registry (getAppTypeForTool, getAppSubtool)
 * from initToolRegistry.ts as the single source of truth.
 * Use getAppSubtool() for category classification.
 */
