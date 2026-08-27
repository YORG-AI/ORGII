/**
 * Git Operations Integration Hook
 *
 * Orchestrator that combines:
 * - Git remote operations (push, pull, fetch)
 * - Git staging operations (commit, stage)
 *
 * Historically this also streamed every operation into the Code Editor's
 * Output panel and logged backend-detected operations there. That panel was
 * archived (see `.archive/README.md`), so the hook is now purely the
 * operation surface; streamed lines are kept in memory only long enough to
 * populate the git error dialog.
 */
import type {
  UseGitOutputIntegrationOptions,
  UseGitOutputIntegrationReturn,
} from "@src/types/workstation/gitOutputIntegration";

import { useGitOperations } from "./useGitOperations";
import { useGitStagingOperations } from "./useGitStagingOperations";

// ============================================
// Main Hook
// ============================================

/**
 * Hook exposing all git operations that stream from the backend:
 * - push, pull, fetch (remote operations)
 * - commit, stage (staging operations)
 */
export function useGitOutputIntegration(
  options: UseGitOutputIntegrationOptions
): UseGitOutputIntegrationReturn {
  const { repoPath, repoId } = options;

  // Git remote operations (push, pull, fetch)
  const { pushWithOutput, pullWithOutput, fetchWithOutput } = useGitOperations({
    repoPath,
    repoId,
  });

  // Git staging operations (commit, stage)
  const { commitWithOutput, stageWithOutput } = useGitStagingOperations({
    repoPath,
    repoId,
  });

  return {
    pushWithOutput,
    pullWithOutput,
    fetchWithOutput,
    commitWithOutput,
    stageWithOutput,
  };
}
