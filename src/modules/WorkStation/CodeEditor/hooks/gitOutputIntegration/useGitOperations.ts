/**
 * Git Remote Operations Hook
 *
 * Provides push, pull, and fetch operations.
 * Uses the factory pattern for consistent behavior.
 */
import { useCallback, useRef } from "react";

import {
  gitFetchStream,
  gitPullStream,
  gitPushStream,
} from "@src/api/http/git/streaming";
import type {
  GitOperationResult,
  OperationContext,
  UseGitOutputIntegrationOptions,
} from "@src/types/workstation/gitOutputIntegration";

import { createGitOperationHandler } from "./createGitOperationHandler";

// ============================================
// Operation Handlers (created once via factory)
// ============================================

interface PushParams {
  remote?: string;
  branch?: string;
  set_upstream?: boolean;
  force?: boolean;
  showErrorDialog?: boolean;
}

interface PullParams {
  remote?: string;
  branch?: string;
  strategy?: string;
  showErrorDialog?: boolean;
}

interface FetchParams {
  remote?: string;
  prune?: boolean;
  showErrorDialog?: boolean;
}

const handlePush = createGitOperationHandler<PushParams>({
  streamFn: gitPushStream,
  operationName: "push",
  operationLabel: "Push",
});

const handlePull = createGitOperationHandler<PullParams>({
  streamFn: gitPullStream,
  operationName: "pull",
  operationLabel: "Pull",
});

const handleFetch = createGitOperationHandler<FetchParams>({
  streamFn: gitFetchStream,
  operationName: "fetch",
  operationLabel: "Fetch",
});

// ============================================
// Hook
// ============================================

export type UseGitOperationsOptions = Pick<
  UseGitOutputIntegrationOptions,
  "repoPath" | "repoId"
>;

export interface UseGitOperationsReturn {
  pushWithOutput: (params: PushParams) => Promise<GitOperationResult>;
  pullWithOutput: (params: PullParams) => Promise<GitOperationResult>;
  fetchWithOutput: (params: FetchParams) => Promise<GitOperationResult>;
}

/**
 * Hook providing git remote operations (push, pull, fetch).
 */
export function useGitOperations(
  options: UseGitOperationsOptions
): UseGitOperationsReturn {
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

  const pushWithOutput = useCallback(
    (params: PushParams): Promise<GitOperationResult> => {
      return handlePush(getContext(), params);
    },
    [getContext]
  );

  const pullWithOutput = useCallback(
    (params: PullParams): Promise<GitOperationResult> => {
      return handlePull(getContext(), params);
    },
    [getContext]
  );

  const fetchWithOutput = useCallback(
    (params: FetchParams): Promise<GitOperationResult> => {
      return handleFetch(getContext(), params);
    },
    [getContext]
  );

  return {
    pushWithOutput,
    pullWithOutput,
    fetchWithOutput,
  };
}
