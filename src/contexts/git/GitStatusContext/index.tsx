/**
 * GitStatusContext - SINGLE SOURCE OF TRUTH
 *
 * Provides git status for the currently selected repo.
 *
 * Usage:
 * - Wrap app with <DeferredGitStatusProvider> (recommended) or <GitStatusProvider>
 * - Use useGitStatus() hook to access git status and actions
 *
 * All other components must:
 * - Use useGitStatus() hook for already-scoped current repo status
 * - Call forceRefresh() after mutations (save, stage, commit)
 * - NEVER create their own event listeners
 */
import { useContext } from "react";

import { DeferredGitStatusProvider } from "./DeferredGitStatusProvider";
import { GitStatusContext } from "./GitStatusProvider";
import type { GitStatusContextValue } from "./types";

// ============================================
// Hook
// ============================================

export function useGitStatus(): GitStatusContextValue {
  const context = useContext(GitStatusContext);
  if (!context) {
    throw new Error("useGitStatus must be used within GitStatusProvider");
  }
  return context;
}

// ============================================
// Exports
// ============================================

export { DeferredGitStatusProvider, GitStatusContext };
export type { GitStatusContextValue };
