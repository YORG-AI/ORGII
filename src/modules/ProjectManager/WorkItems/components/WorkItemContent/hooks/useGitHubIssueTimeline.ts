import { useEffect, useMemo, useState } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import { fetchIssueTimeline } from "@src/services/git/operations/githubIssues";

interface GitHubIssueTimelineState {
  requestKey: string;
  timeline: GitHubIssueTimelineItem[];
  loading: boolean;
  error: string | null;
}

interface UseGitHubIssueTimelineOptions {
  enabled: boolean;
  repoPath?: string | null;
  shortId?: string | null;
}

export function parseGitHubIssueNumber(
  shortId: string | null | undefined
): number | null {
  if (!shortId) return null;
  const normalized = shortId.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) return null;
  const issueNumber = Number(normalized);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : null;
}

async function resolveRemoteUrl(repoPath: string): Promise<string | null> {
  if (parseGithubRepoFullName(repoPath)) return repoPath;

  const remotes = await getGitRemotes({
    repo_id: "default",
    repo_path: repoPath,
  });
  const origin = remotes?.remotes?.find((remote) => remote.name === "origin");
  const fallback = remotes?.remotes?.[0];
  return (
    origin?.url ||
    origin?.fetch_url ||
    fallback?.url ||
    fallback?.fetch_url ||
    null
  );
}

export function useGitHubIssueTimeline({
  enabled,
  repoPath,
  shortId,
}: UseGitHubIssueTimelineOptions): {
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  timelineError: string | null;
} {
  const issueNumber = useMemo(() => parseGitHubIssueNumber(shortId), [shortId]);
  const requestKey =
    enabled && repoPath && issueNumber ? `${repoPath}:${issueNumber}` : "";
  const [state, setState] = useState<GitHubIssueTimelineState | null>(null);
  const currentState = state?.requestKey === requestKey ? state : null;

  useEffect(() => {
    if (!requestKey || !repoPath || !issueNumber) return;

    let cancelled = false;

    void (async () => {
      const remoteUrl = await resolveRemoteUrl(repoPath);
      if (!remoteUrl) {
        if (!cancelled) {
          setState({
            requestKey,
            timeline: [],
            loading: false,
            error: "no_github_remote",
          });
        }
        return;
      }

      const result = await fetchIssueTimeline({ remoteUrl, issueNumber });
      if (!cancelled) {
        setState({
          requestKey,
          timeline: result.data ?? [],
          loading: false,
          error: result.error ?? null,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [issueNumber, repoPath, requestKey]);

  return {
    timeline: currentState?.timeline ?? [],
    timelineLoading: Boolean(requestKey) && (currentState?.loading ?? true),
    timelineError: currentState?.error ?? null,
  };
}
