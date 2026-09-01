/**
 * TypeScript definitions for Flow Awareness system.
 *
 * These types ensure consistency between frontend and Rust backend
 * while providing better developer experience with autocompletion.
 */

// ============================================
// Base Types
// ============================================

/** All supported activity types in the flow awareness system. */
export type ActivityType =
  | "file_edit"
  | "file_open"
  | "terminal_command"
  | "search"
  | "clipboard"
  | "git_operation"
  | "navigation"
  | "error"
  | "debug";

/** File edit types indicating the nature of the change. */
export type FileEditType = "create" | "modify" | "delete" | "rename";

/** Search scope indicating where the search was performed. */
export type SearchScope = "codebase" | "current_file" | "files";

/** Clipboard operations for tracking copy/paste patterns. */
export type ClipboardOp = "copy" | "cut" | "paste";

/** Git operation types for version control tracking. */
export type GitOpType =
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "branch_switch"
  | "branch_create"
  | "merge"
  | "rebase"
  | "stash"
  | "stash_pop"
  | "checkout"
  | "diff"
  | "status";

/** Navigation targets for tracking user interface focus. */
export type NavigationTarget =
  | "file"
  | "tab"
  | "panel"
  | "view"
  | "definition"
  | "reference"
  | "symbol";

/** Error types for categorizing development issues. */
export type ErrorType = "build" | "test" | "lint" | "type_check" | "runtime";

/** Debug actions for tracking debugging sessions. */
export type DebugAction =
  | "set_breakpoint"
  | "remove_breakpoint"
  | "step_over"
  | "step_into"
  | "step_out"
  | "continue"
  | "pause"
  | "inspect_variable";

// ============================================
// Interface Definitions
// ============================================

/** Complete activity input structure for recording activities. */
export interface ActivityInput {
  /** Type of activity being recorded. */
  type: ActivityType;
  /** Session ID to associate this activity with (optional). */
  sessionId?: string;
  /** File path (for file-related activities). */
  path?: string;
  /** Type of file edit (for file_edit activities). */
  editType?: FileEditType;
  /** Approximate number of lines changed (for file_edit activities). */
  linesChanged?: number;
  /** Command that was executed (for terminal_command activities). */
  command?: string;
  /** Working directory where command was run (for terminal_command activities). */
  workingDir?: string;
  /** Exit code of command (for terminal_command activities). */
  exitCode?: number;
  /** Search query text (for search activities). */
  query?: string;
  /** Scope of search (for search activities). */
  scope?: SearchScope;
  /** Number of search results found (for search activities). */
  resultCount?: number;
  /** Type of clipboard operation (for clipboard activities). */
  operation?: ClipboardOp;
  /** Preview of clipboard content (for clipboard activities). */
  contentPreview?: string;
  /** Source file for clipboard content (for clipboard activities). */
  sourceFile?: string;
  /** Type of git operation (for git_operation activities). */
  gitOp?: GitOpType;
  /** Additional details about the activity. */
  details?: string;
  /** Navigation target (for navigation activities). */
  target?: NavigationTarget;
  /** Type of error encountered (for error activities). */
  errorType?: ErrorType;
  /** Error message text (for error activities). */
  message?: string;
  /** Line number related to activity (for error/debug activities). */
  line?: number;
  /** Debug action performed (for debug activities). */
  action?: DebugAction;
}

/** Flow summary providing aggregated view of recent user activity. */
export interface FlowSummary {
  /** Inferred user intent based on activity patterns. */
  intent: string | null;
  /** List of recently edited file paths. */
  recentEdits: string[];
  /** List of recently opened file paths. */
  recentOpens: string[];
  /** List of recent terminal commands. */
  recentCommands: string[];
  /** List of recent search queries. */
  recentSearches: string[];
  /** List of current error messages. */
  currentErrors: string[];
  /** Seconds since last recorded activity. */
  idleSeconds: number | null;
}

// ============================================
// Hook Configuration Types
// ============================================

/** Options for configuring the useFlowAwareness hook. */
export interface UseFlowAwarenessOptions {
  /** Session ID to associate activities with. */
  sessionId?: string;
  /** Whether to enable activity tracking (default: true). */
  enabled?: boolean;
  /** Custom debounce interval in milliseconds. */
  debounceMs?: number;
  /** Maximum activities to batch before flushing. */
  maxBatchSize?: number;
}

/** Return type of the useFlowAwareness hook with all available methods. */
export interface UseFlowAwarenessReturn {
  // Core recording functions
  recordActivity: (activity: ActivityInput) => void;

  // Convenience recording functions
  recordFileEdit: (
    path: string,
    editType: FileEditType,
    linesChanged?: number
  ) => void;
  recordFileOpen: (path: string) => void;
  recordTerminalCommand: (
    command: string,
    workingDir?: string,
    exitCode?: number
  ) => void;
  recordSearch: (
    query: string,
    scope?: SearchScope,
    resultCount?: number
  ) => void;
  recordClipboard: (
    operation: ClipboardOp,
    contentPreview?: string,
    sourceFile?: string
  ) => void;
  recordGitOperation: (operation: GitOpType, details?: string) => void;
  recordNavigation: (target: NavigationTarget, details?: string) => void;
  recordError: (
    errorType: ErrorType,
    message: string,
    filePath?: string,
    line?: number
  ) => void;
  recordDebug: (action: DebugAction, filePath?: string, line?: number) => void;

  // Query functions
  getContext: (maxActivities?: number) => Promise<string>;
  getSummary: (maxActivities?: number) => Promise<FlowSummary>;
  clearSession: () => Promise<void>;
}
