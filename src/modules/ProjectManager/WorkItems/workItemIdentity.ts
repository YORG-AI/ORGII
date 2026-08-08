import {
  type ProjectSyncAdapterType,
  STORY_SYNC_ADAPTER,
} from "@src/api/http/integrations/syncConnections";
import { WORK_ITEM_STATUS } from "@src/types/core/workItem";

export function isGitHubIssueStatus(status?: string | null): boolean {
  return (
    status === WORK_ITEM_STATUS.GITHUB_OPEN ||
    status === WORK_ITEM_STATUS.GITHUB_CLOSED
  );
}

export function getWorkItemSourceIntegration(
  status?: string | null,
  workspaceSource?: string | null
): ProjectSyncAdapterType | null {
  if (isGitHubIssueStatus(status)) return STORY_SYNC_ADAPTER.GITHUB;
  if (workspaceSource === STORY_SYNC_ADAPTER.LINEAR) {
    return STORY_SYNC_ADAPTER.LINEAR;
  }
  return null;
}

/** Render a GitHub issue as `#42`, or `REP #42` when its repository is known. */
export function formatWorkItemShortId(
  shortId: string | null | undefined,
  status?: string | null,
  repositoryNameOrPrefix?: string | null
): string | null {
  if (!shortId) return null;
  if (!isGitHubIssueStatus(status)) return shortId;
  const issueNumber = shortId.replace(/^.*#/, "");
  if (!repositoryNameOrPrefix) return `#${issueNumber}`;

  const repositoryName =
    repositoryNameOrPrefix
      .replace(/\.git$/i, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? repositoryNameOrPrefix;
  const repositoryPrefix = repositoryName
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 3)
    .toUpperCase()
    .padEnd(3, "X");

  return `${repositoryPrefix} #${issueNumber}`;
}
