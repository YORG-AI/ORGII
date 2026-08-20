import { appendGitCoauthorTrailer } from "@src/services/git/operations/commitAttribution";
import type { GitFile } from "@src/types/git/types";

export interface CommitPayload {
  repo_id: string;
  repo_path?: string;
  message: string;
  description?: string;
  files: string[];
}

export interface CommitFileSelection {
  stagedFiles: GitFile[];
  filesToCommit: GitFile[];
  wasSmartCommit: boolean;
}

export type CommitSuccessAction =
  | "committed"
  | "committed and pushed"
  | "committed and published"
  | "committed and synced";

export function formatCommitMessage(message: string): string {
  return appendGitCoauthorTrailer(message);
}

export function getCommitFileSelection(files: GitFile[]): CommitFileSelection {
  const stagedFiles = files.filter((file) => file.staged);
  const filesToCommit = stagedFiles.length > 0 ? stagedFiles : files;

  return {
    stagedFiles,
    filesToCommit,
    wasSmartCommit: stagedFiles.length === 0,
  };
}

export function createCommitPayload(params: {
  selectedRepoId: string;
  repoPath?: string;
  commitSummary: string;
  commitDescription: string;
  filesToCommit: GitFile[];
}): CommitPayload {
  const payload: CommitPayload = {
    repo_id: params.selectedRepoId,
    repo_path: params.repoPath,
    message: formatCommitMessage(params.commitSummary.trim()),
    files: params.filesToCommit.map((file) => file.path),
  };

  const trimmedDescription = params.commitDescription.trim();
  if (trimmedDescription) {
    payload.description = trimmedDescription;
  }

  return payload;
}

export function buildCommitSuccessMessage(params: {
  action: CommitSuccessAction;
  fileCount: number;
  wasSmartCommit: boolean;
}): string {
  const pluralSuffix = params.fileCount !== 1 ? "s" : "";
  const smartCommitSuffix = params.wasSmartCommit ? " (Smart Commit)" : "";

  return `Successfully ${params.action} ${params.fileCount} file${pluralSuffix}${smartCommitSuffix}`;
}

export function buildAmendSuccessMessage(params: {
  fileCount: number;
  wasSmartCommit: boolean;
}): string {
  if (params.fileCount === 0) {
    return "Successfully amended commit message";
  }

  const pluralSuffix = params.fileCount !== 1 ? "s" : "";
  const smartCommitSuffix = params.wasSmartCommit ? " (Smart Commit)" : "";

  return `Successfully amended commit with ${params.fileCount} file${pluralSuffix}${smartCommitSuffix}`;
}

export function getDialogErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  return error instanceof Error ? error.message : fallbackMessage;
}
