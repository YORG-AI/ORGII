/**
 * Git Operation Types
 *
 * Contract for the git operation hook (CodeEditor/hooks/gitOutputIntegration).
 * Lives in src/types so store/ atoms and other consumers can reference the
 * contract without importing the hook implementation.
 *
 * The `WithOutput` method names are historical: these operations used to
 * stream their stdout/stderr into the Code Editor's Output panel. That panel
 * was archived (see `.archive/README.md` — "LSP / lint / Output / Test panels"),
 * so streamed lines are now only accumulated in memory to populate the git
 * error dialog. The names are kept to avoid churning every call site.
 */
import type { MutableRefObject } from "react";

import type { GitErrorType } from "@src/api/http/git/streaming";

// ============================================
// Result Types
// ============================================

/** Result of a git operation with success status and error type */
export interface GitOperationResult {
  success: boolean;
  errorType: GitErrorType;
}

// ============================================
// Options & Return Types
// ============================================

export interface UseGitOutputIntegrationOptions {
  /** Repository path */
  repoPath: string;
  /** Repository ID */
  repoId: string;
}

export interface UseGitOutputIntegrationReturn {
  /** Push — resolves with result including error type */
  pushWithOutput: (params: {
    remote?: string;
    branch?: string;
    set_upstream?: boolean;
    force?: boolean;
    showErrorDialog?: boolean;
  }) => Promise<GitOperationResult>;
  /** Pull — resolves with result including error type */
  pullWithOutput: (params: {
    remote?: string;
    branch?: string;
    strategy?: string;
    showErrorDialog?: boolean;
  }) => Promise<GitOperationResult>;
  /** Fetch — resolves with result including error type */
  fetchWithOutput: (params: {
    remote?: string;
    prune?: boolean;
    showErrorDialog?: boolean;
  }) => Promise<GitOperationResult>;
  /** Commit — resolves with cleanup function when complete */
  commitWithOutput: (params: {
    message: string;
    coauthor?: boolean;
  }) => Promise<() => void>;
  /** Stage — resolves with cleanup function when complete */
  stageWithOutput: (params: { files: string[] }) => Promise<() => void>;
}

// ============================================
// Internal Types
// ============================================

/** Context passed to operation handlers */
export interface OperationContext {
  repoPath: string;
  repoId: string;
  cleanupRef: MutableRefObject<(() => void) | null>;
}

/** Git operation type for error dialogs */
export type GitOperationType =
  | "push"
  | "pull"
  | "fetch"
  | "commit"
  | "stage"
  | "checkout"
  | "merge"
  | "rebase";
