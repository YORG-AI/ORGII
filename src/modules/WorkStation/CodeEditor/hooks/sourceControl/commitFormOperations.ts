import type { GitFile } from "@src/types/git/types";
import type { UseGitOutputIntegrationReturn } from "@src/types/workstation/gitOutputIntegration";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import {
  type CommitSuccessAction,
  buildAmendSuccessMessage,
  buildCommitSuccessMessage,
  createCommitPayload,
  formatCommitMessage,
  getCommitFileSelection,
  getDialogErrorMessage,
} from "./commitFormHelpers";

type CommitDispatch = (
  type: string,
  payload?: Record<string, unknown>,
  source?: "user" | "ai" | "system"
) => Promise<unknown>;

type CommitSuccessHandler = (options?: {
  pushed?: boolean;
}) => void | Promise<void>;

export interface CommitOperationParams {
  selectedRepoId: string | null;
  repoPath?: string;
  files: GitFile[];
  commitSummary: string;
  commitDescription: string;
  outputIntegration: UseGitOutputIntegrationReturn | null;
  dispatch?: CommitDispatch;
  onCommitSuccess?: CommitSuccessHandler;
  setCommitLoading: (loading: boolean) => void;
  clearCommitForm: () => void;
  action: CommitSuccessAction;
  fallbackErrorMessage: string;
  pushed?: boolean;
  beforeCommit?: () => Promise<boolean>;
  afterCommit?: () => Promise<void>;
}

export interface AmendOperationParams {
  selectedRepoId: string | null;
  files: GitFile[];
  commitSummary: string;
  outputIntegration: UseGitOutputIntegrationReturn | null;
  dispatch?: CommitDispatch;
  onCommitSuccess?: CommitSuccessHandler;
  setCommitLoading: (loading: boolean) => void;
  clearCommitForm: () => void;
}

async function stageFilesIfNeeded(params: {
  files: GitFile[];
  stagedFiles: GitFile[];
  outputIntegration: UseGitOutputIntegrationReturn | null;
  dispatch?: CommitDispatch;
}): Promise<void> {
  if (params.stagedFiles.length > 0 || params.files.length === 0) {
    return;
  }

  const paths = params.files.map((file) => file.path);

  if (params.outputIntegration) {
    await params.outputIntegration.stageWithOutput({ files: paths });
    return;
  }

  if (params.dispatch) {
    await params.dispatch("git.stage", { paths }, "user");
  }
}

async function executeCommit(params: {
  message: string;
  files: GitFile[];
  stagedFiles: GitFile[];
  outputIntegration: UseGitOutputIntegrationReturn | null;
  dispatch?: CommitDispatch;
}): Promise<void> {
  await stageFilesIfNeeded(params);

  if (params.outputIntegration && params.message) {
    await params.outputIntegration.commitWithOutput({
      message: params.message,
    });
    return;
  }

  if (params.dispatch) {
    await params.dispatch("git.commit", { message: params.message }, "user");
  }
}

async function executeAmend(params: {
  message?: string;
  files: GitFile[];
  stagedFiles: GitFile[];
  outputIntegration: UseGitOutputIntegrationReturn | null;
  dispatch?: CommitDispatch;
}): Promise<void> {
  await stageFilesIfNeeded(params);

  if (params.dispatch) {
    await params.dispatch("git.amend", { message: params.message }, "user");
  }
}

export async function runCommitOperation(
  params: CommitOperationParams
): Promise<void> {
  if (!params.selectedRepoId || !params.commitSummary.trim()) {
    return;
  }

  const selection = getCommitFileSelection(params.files);

  if (selection.filesToCommit.length === 0) {
    showGitActionDialogSafely("No files to commit", "error");
    return;
  }

  if (params.beforeCommit && !(await params.beforeCommit())) {
    return;
  }

  params.setCommitLoading(true);

  try {
    const payload = createCommitPayload({
      selectedRepoId: params.selectedRepoId,
      repoPath: params.repoPath,
      commitSummary: params.commitSummary,
      commitDescription: params.commitDescription,
      filesToCommit: selection.filesToCommit,
    });

    await executeCommit({
      message: payload.message,
      files: params.files,
      stagedFiles: selection.stagedFiles,
      outputIntegration: params.outputIntegration,
      dispatch: params.dispatch,
    });

    if (params.afterCommit) {
      await params.afterCommit();
    }

    showGitActionDialogSafely(
      buildCommitSuccessMessage({
        action: params.action,
        fileCount: selection.filesToCommit.length,
        wasSmartCommit: selection.wasSmartCommit,
      }),
      "info"
    );

    params.clearCommitForm();

    if (params.onCommitSuccess) {
      await params.onCommitSuccess(
        params.pushed ? { pushed: params.pushed } : undefined
      );
    }
  } catch (error: unknown) {
    showGitActionDialogSafely(
      getDialogErrorMessage(error, params.fallbackErrorMessage),
      "error"
    );
  } finally {
    params.setCommitLoading(false);
  }
}

export async function runAmendOperation(
  params: AmendOperationParams
): Promise<void> {
  if (!params.selectedRepoId) {
    return;
  }

  const selection = getCommitFileSelection(params.files);

  if (selection.filesToCommit.length === 0 && !params.commitSummary.trim()) {
    showGitActionDialogSafely("No files or message to amend", "error");
    return;
  }

  params.setCommitLoading(true);

  try {
    await executeAmend({
      message: params.commitSummary.trim()
        ? formatCommitMessage(params.commitSummary.trim())
        : undefined,
      files: params.files,
      stagedFiles: selection.stagedFiles,
      outputIntegration: params.outputIntegration,
      dispatch: params.dispatch,
    });

    showGitActionDialogSafely(
      buildAmendSuccessMessage({
        fileCount: selection.filesToCommit.length,
        wasSmartCommit: selection.wasSmartCommit,
      }),
      "info"
    );

    params.clearCommitForm();

    if (params.onCommitSuccess) {
      await params.onCommitSuccess();
    }
  } catch (error: unknown) {
    showGitActionDialogSafely(
      getDialogErrorMessage(error, "Failed to amend commit"),
      "error"
    );
  } finally {
    params.setCommitLoading(false);
  }
}
