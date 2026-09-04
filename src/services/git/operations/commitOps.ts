/**
 * Commit Operations — stage, unstage, discard, commit, amend
 */
import { gitApi } from "@src/api/http/git";
import { showGitErrorAndHandle } from "@src/hooks/git/gitErrorDialog";

import {
  appendGitCoauthorTrailer,
  shouldIncludeGitCoauthor,
} from "./commitAttribution";
import { noRepoContextFailure } from "./noRepoContext";
import {
  type GitOperationResult,
  getOutputIntegration,
  getRepoContext,
  parseGitError,
} from "./types";

// ============================================
// Core Operations
// ============================================

/**
 * Stage files
 * Uses streaming output if available, falls back to API/terminal
 */
export async function stage(paths?: string[]): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const filesToStage = paths || ["."];

  if (integration) {
    try {
      await integration.stageWithOutput({ files: filesToStage });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  const repo = getRepoContext();
  if (repo) {
    try {
      await gitApi.gitStageFiles({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        files: filesToStage,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  return noRepoContextFailure("staging");
}

/**
 * Unstage files
 */
export async function unstage(paths?: string[]): Promise<GitOperationResult> {
  const filesToUnstage = paths || ["."];
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitUnstageFiles({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        files: filesToUnstage,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  return noRepoContextFailure("unstaging");
}

/**
 * Discard changes to files
 */
export async function discard(paths: string[]): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitDiscardChanges({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        files: paths,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  // Especially important for discard: the old terminal fallback interpolated
  // paths unquoted into a destructive command in an arbitrary cwd.
  return noRepoContextFailure("the discard");
}

/**
 * Discard all unstaged changes
 */
export async function discardAll(): Promise<GitOperationResult> {
  return discard(["."]);
}

/**
 * Resolve a merge conflict file using a strategy (ours/theirs)
 */
export async function resolveConflict(
  filePath: string,
  strategy: "ours" | "theirs"
): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitResolveConflict({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        file: filePath,
        strategy,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  return noRepoContextFailure("the conflict resolution");
}

/**
 * Commit staged changes
 * Uses streaming output if available
 */
export async function commit(message: string): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const commitMessage = appendGitCoauthorTrailer(message);

  if (integration) {
    try {
      await integration.commitWithOutput({ message: commitMessage });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  const repo = getRepoContext();
  if (repo) {
    try {
      await gitApi.gitCommit({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        message: commitMessage,
        coauthor: shouldIncludeGitCoauthor(),
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  return noRepoContextFailure("the commit");
}

/**
 * Amend the last commit
 */
export async function amend(message?: string): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitAmendCommit({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        message,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  return noRepoContextFailure("the amend");
}

// ============================================
// Operations with Error Dialog
// ============================================

/**
 * Stage files with error dialog on failure
 */
export async function stageWithDialog(
  paths?: string[]
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const repoContext = getRepoContext();
  const result = await stage(paths);

  if (!integration && !result.success && result.errorType !== "none") {
    await showGitErrorAndHandle({
      operation: "stage",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Stage failed",
    });
  }
  return result;
}

/**
 * Unstage files with error dialog on failure
 */
export async function unstageWithDialog(
  paths?: string[]
): Promise<GitOperationResult> {
  const repoContext = getRepoContext();
  const result = await unstage(paths);

  if (!result.success && result.errorType !== "none") {
    await showGitErrorAndHandle({
      operation: "unstage",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Unstage failed",
    });
  }
  return result;
}

/**
 * Commit with error dialog on failure
 */
export async function commitWithDialog(
  message: string
): Promise<GitOperationResult> {
  const integration = getOutputIntegration();
  const repoContext = getRepoContext();
  const result = await commit(message);

  if (!integration && !result.success && result.errorType !== "none") {
    await showGitErrorAndHandle({
      operation: "commit",
      repoId: repoContext?.repoId,
      repoPath: repoContext?.repoPath,
      errorType: result.errorType,
      errorMessage: result.message || "Commit failed",
    });
  }
  return result;
}
