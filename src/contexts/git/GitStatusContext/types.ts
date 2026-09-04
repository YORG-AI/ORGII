/**
 * Types for GitStatusContext
 */
import type { MutableRefObject } from "react";

import type { ScopedGitStatusState } from "@src/store/git";
import type {
  GitRepositoryStatus,
  GitSuggestedAction,
} from "@src/types/session/steps";

// ============================================
// Context Value
// ============================================

export interface GitStatusContextValue {
  currentGitStatus: GitRepositoryStatus | null;
  scopedGitStatus: ScopedGitStatusState | null;
  gitSuggestedAction: GitSuggestedAction | null;
  loading: boolean;
  error: string | null;
  forceRefresh: () => Promise<void>;
  hasActiveRepo: boolean;
}

// ============================================
// Startup State
// ============================================

/**
 * Startup states for initialization tracking.
 * More semantic than time-based grace periods.
 */
export type StartupState = "initializing" | "loading" | "ready";

// ============================================
// Shared Refs Type (passed between hooks)
// ============================================

export interface GitStatusRefs {
  currentRepoIdRef: MutableRefObject<string | null>;
  gitStatusRef: MutableRefObject<GitRepositoryStatus | null>;
  registeredReposRef: MutableRefObject<Set<string>>;
  pendingWatcherTimeoutRef: MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  intendedRepoIdRef: MutableRefObject<string | null>;
  pendingFetchTimeoutRef: MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;
  startupStateRef: MutableRefObject<StartupState>;
  fetchInProgressRef: MutableRefObject<boolean>;
}
