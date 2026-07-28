/**
 * Git & Repository Management Hooks
 *
 * CONSOLIDATED (Jan 25, 2026)
 * - useGitOperations: Unified hook for git push/pull/fetch/publish/sync
 * - useRepoSelection: Main hook for repo/branch selection
 * - useRepoState: Read-only hook for components that just need state
 * - useRepoDropdownActions: Dropdown menu actions
 * - useGitHubConnections: GitHub connection management
 *
 * Git status is now handled by:
 * - GitStatusContext: Single repo status (see contexts/)
 * - MultiRepoGitStatusContext: Multi-repo status for badges (see contexts/)
 */

// Unified git operations hook (push, pull, fetch, publish, sync)
export { useGitOperations } from "./useGitOperations";

// Background auto-fetch (wires gitAutoFetchAtom to a real timer)
export { useGitAutoFetch } from "./useGitAutoFetch";

// GitHub connections management
export { useGitHubConnections } from "./useGitHubConnections";

// Primary hook for repo/branch selection
export { useRepoSelection } from "./useRepoSelection";

// Read-only hook for repo state (lightweight)
export { useRepoState } from "./useRepoState";

// Checks whether a workspace path currently has a .git directory
export { useRepoGitInitialization } from "./useRepoGitInitialization";
export type {
  RepoGitInitializationState,
  UseRepoGitInitializationReturn,
} from "./useRepoGitInitialization";

// Dropdown menu actions
export { useRepoDropdownActions } from "./useRepoDropdownActions";

// Git error dialog (standalone function for git errors)
export { showGitErrorAndHandle } from "./useGitErrorDialog";

// File history hook
export { useFileHistory } from "./useFileHistory";

// Git blame hook (inline blame annotations)
export { useGitBlame } from "./useGitBlame";
export type { UseGitBlameOptions, UseGitBlameReturn } from "./useGitBlame";

// Source control hooks (for git file list, diff caching, commit form)
export { useCommitForm, useFileSelection, useGitFiles } from "./sourceControl";
