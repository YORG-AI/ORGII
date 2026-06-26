/**
 * Git Remote Operations Hook
 *
 * Provides push, pull, and fetch operations with output streaming.
 * Uses the factory pattern for consistent behavior.
 */
import { useCallback, useRef } from "react";

import {
  gitFetchStream,
  gitPullStream,
  gitPushStream,
} from "@src/api/http/git/streaming";

import { createGitOperationHandler } from "./createGitOperationHandler";
import { formatTimestamp } from "./formatters";
import type {
  GitOperationResult,
  OperationContext,
  OutputChannel,
  UseGitOutputIntegrationOptions,
} from "./types";

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
  formatCommand: (params) => {
    const remote = params.remote || "origin";
    return `git push ${remote}${params.branch ? ` ${params.branch}` : ""}${params.set_upstream ? " -u" : ""}${params.force ? " --force" : ""}`;
  },
  operationName: "push",
  operationLabel: "Push",
});

const handlePull = createGitOperationHandler<PullParams>({
  streamFn: gitPullStream,
  formatCommand: (params) => {
    const remote = params.remote || "origin";
    const strategyFlag =
      params.strategy === "rebase"
        ? " --rebase"
        : params.strategy === "ff-only"
          ? " --ff-only"
          : " --no-rebase";
    return `git pull${strategyFlag} ${remote}${params.branch ? ` ${params.branch}` : ""}`;
  },
  operationName: "pull",
  operationLabel: "Pull",
});

const handleFetch = createGitOperationHandler<FetchParams>({
  streamFn: gitFetchStream,
  formatCommand: (params) => {
    const remote = params.remote || "origin";
    return `git fetch ${remote}${params.prune ? " --prune" : ""}`;
  },
  operationName: "fetch",
  operationLabel: "Fetch",
});

// ============================================
// Hook
// ============================================

export interface UseGitOperationsOptions extends Pick<
  UseGitOutputIntegrationOptions,
  | "outputState"
  | "repoPath"
  | "repoId"
  | "autoSwitchToOutput"
  | "onSwitchToOutput"
> {
  /** Get or create the git channel */
  getGitChannel: () => OutputChannel;
}

export interface UseGitOperationsReturn {
  pushWithOutput: (params: PushParams) => Promise<GitOperationResult>;
  pullWithOutput: (params: PullParams) => Promise<GitOperationResult>;
  fetchWithOutput: (params: FetchParams) => Promise<GitOperationResult>;
}

/**
 * Hook providing git remote operations (push, pull, fetch) with output streaming.
 */
export function useGitOperations(
  options: UseGitOperationsOptions
): UseGitOperationsReturn {
  const {
    outputState,
    repoPath,
    repoId,
    autoSwitchToOutput = true,
    onSwitchToOutput,
    getGitChannel,
  } = options;

  const cleanupRef = useRef<(() => void) | null>(null);

  // Build operation context
  const getContext = useCallback((): OperationContext => {
    return {
      outputState,
      repoPath,
      repoId,
      autoSwitchToOutput,
      onSwitchToOutput,
      getGitChannel,
      formatTimestamp,
      cleanupRef,
    };
  }, [
    outputState,
    repoPath,
    repoId,
    autoSwitchToOutput,
    onSwitchToOutput,
    getGitChannel,
  ]);

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
