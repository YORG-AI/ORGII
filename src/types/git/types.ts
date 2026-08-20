/**
 * Git Types - Pure Type Definitions
 *
 * This file contains types used by multiple modules:
 * - EditorPrimarySidebar (hooks, content)
 * - EditorContent (GitDiffContent, SourceControlMainContent)
 * - @src/modules/WorkStation/CodeEditor/hooks/ (sourceControl, gitOutputIntegration)
 * - @src/store/git/gitStatusAtom.ts
 * - @src/engines/Simulator/
 */
import type { GitFileStatus } from "@src/config/gitStatus";

/** Shared presentation mode for Git review diff surfaces. */
export type DiffViewMode = "unified" | "split";

// Re-export GitFileStatus for convenience
export type { GitFileStatus } from "@src/config/gitStatus";

// Re-export status helpers
export {
  getStatusColor,
  getStatusLetter,
  getStatusBgColor,
  getStatusLabel,
  getStatusInfo,
  getStatusLetterForFile,
  getStatusColorForFile,
  normalizeGitStatus,
} from "@src/config/gitStatus";

/**
 * Git file representation used throughout the application
 */
export interface GitFile {
  id: string;
  path: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  oldContent?: string;
  newContent?: string;
  staged: boolean;
  original_path?: string | null;
  /** Absolute path of the git repo / worktree root this file belongs to.
   *  Set when the file comes from a worktree that differs from the host's
   *  main repoPath so diff API calls use the correct repo_path. */
  repoRoot?: string;
  /** Unique session attribution for Source Control, when exactly one session claims this file. */
  sourceSessionId?: string;
  /** All session IDs whose session-file history references this file. */
  sessionIds?: string[];
}

/**
 * Loading state for git actions (keyed by file path or operation ID)
 */
export type ActionLoadingState = Record<string, boolean>;
