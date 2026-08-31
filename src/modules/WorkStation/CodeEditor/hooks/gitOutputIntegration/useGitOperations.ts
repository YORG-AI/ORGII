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

  // One cleanup ref PER operation. A single shared ref meant starting any
  // operation closed the previous operation's event source — whose promise
  // then never settled (its callbacks can no longer fire), leaving that
  // operation's loading flag stuck for the rest of the session (e.g. Fetch
  // permanently disabled after clicking Pull mid-fetch).
  const pushCleanupRef = useRef<(() => void) | null>(null);
  const pullCleanupRef = useRef<(() => void) | null>(null);
  const fetchCleanupRef = useRef<(() => void) | null>(null);

  const makeContext = useCallback(
    (cleanupRef: OperationContext["cleanupRef"]): OperationContext => {
      return {
        repoPath,
        repoId,
        cleanupRef,
      };
    },
    [repoPath, repoId]
  );

  const pushWithOutput = useCallback(
    (params: PushParams): Promise<GitOperationResult> => {
      return handlePush(makeContext(pushCleanupRef), params);
    },
    [makeContext]
  );

  const pullWithOutput = useCallback(
    (params: PullParams): Promise<GitOperationResult> => {
      return handlePull(makeContext(pullCleanupRef), params);
    },
    [makeContext]
  );

  const fetchWithOutput = useCallback(
    (params: FetchParams): Promise<GitOperationResult> => {
      return handleFetch(makeContext(fetchCleanupRef), params);
    },
    [makeContext]
  );

  return {
    pushWithOutput,
    pullWithOutput,
    fetchWithOutput,
  };
}
