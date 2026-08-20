/**
 * Git Staging Operations Hook
 *
 * Provides commit and stage operations with output streaming.
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
  OutputChannel,
  UseGitOutputIntegrationOptions,
} from "@src/types/workstation/gitOutputIntegration";

import { createGitOperationHandlerWithReject } from "./createGitOperationHandler";
import { ANSI, formatTimestamp } from "./formatters";

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
  formatCommand: (params) => `git commit -m "${params.message}"`,
  operationName: "commit",
  operationLabel: "Commit",
});

const handleStage = createGitOperationHandlerWithReject<StageParams>({
  streamFn: gitStageStream,
  formatCommand: (params) => `git add ${params.files.join(" ")}`,
  operationName: "stage",
  operationLabel: "Stage",
  formatSuccessMsg: (params, durationMs) => {
    const timestamp = formatTimestamp();
    return `${timestamp} ${ANSI.green}[info]${ANSI.reset} ✓ Staged ${params.files.length} file(s) [${ANSI.gray}${durationMs}ms${ANSI.reset}]\n`;
  },
});

// ============================================
// Hook
// ============================================

export interface UseGitStagingOperationsOptions extends Pick<
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

export interface UseGitStagingOperationsReturn {
  commitWithOutput: (params: CommitParams) => Promise<() => void>;
  stageWithOutput: (params: StageParams) => Promise<() => void>;
}

/**
 * Hook providing git staging operations (commit, stage) with output streaming.
 */
export function useGitStagingOperations(
  options: UseGitStagingOperationsOptions
): UseGitStagingOperationsReturn {
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
