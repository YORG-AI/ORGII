/**
 * Git Staging Operations Hook
 *
 * Provides commit and stage operations.
 * Uses the factory pattern for consistent behavior.
 */
import { useCallback, useRef } from "react";

import { gitCommitStream, gitStageStream } from "@src/api/http/git/streaming";
import {
  appendGitCoauthorTrailer,
  shouldIncludeGitCoauthor,
} from "@src/services/git/operations/commitAttribution";
import type {
  OperationContext,
  UseGitOutputIntegrationOptions,
} from "@src/types/workstation/gitOutputIntegration";

import { createGitOperationHandlerWithReject } from "./createGitOperationHandler";

// ============================================
// Operation Handlers (created once via factory)
// ============================================

interface CommitParams {
  message: string;
  coauthor?: boolean;
}

interface StageParams {
  files: string[];
}

const handleCommit = createGitOperationHandlerWithReject<CommitParams>({
  streamFn: gitCommitStream,
  operationName: "commit",
  operationLabel: "Commit",
});

const handleStage = createGitOperationHandlerWithReject<StageParams>({
  streamFn: gitStageStream,
  operationName: "stage",
  operationLabel: "Stage",
});

// ============================================
// Hook
// ============================================

export type UseGitStagingOperationsOptions = Pick<
  UseGitOutputIntegrationOptions,
  "repoPath" | "repoId"
>;

export interface UseGitStagingOperationsReturn {
  commitWithOutput: (params: CommitParams) => Promise<() => void>;
  stageWithOutput: (params: StageParams) => Promise<() => void>;
}

/**
 * Hook providing git staging operations (commit, stage).
 */
export function useGitStagingOperations(
  options: UseGitStagingOperationsOptions
): UseGitStagingOperationsReturn {
  const { repoPath, repoId } = options;

  const cleanupRef = useRef<(() => void) | null>(null);

  // Build operation context
  const getContext = useCallback((): OperationContext => {
    return {
      repoPath,
      repoId,
      cleanupRef,
    };
  }, [repoPath, repoId]);

  const commitWithOutput = useCallback(
    (params: CommitParams): Promise<() => void> => {
      return handleCommit(getContext(), {
        ...params,
        message: appendGitCoauthorTrailer(params.message),
        coauthor: shouldIncludeGitCoauthor(),
      });
    },
    [getContext]
  );

  const stageWithOutput = useCallback(
    (params: StageParams): Promise<() => void> => {
      return handleStage(getContext(), params);
    },
    [getContext]
  );

  return {
    commitWithOutput,
    stageWithOutput,
  };
}
