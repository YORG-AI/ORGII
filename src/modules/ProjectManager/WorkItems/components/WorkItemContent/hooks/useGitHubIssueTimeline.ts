import { useStore } from "jotai";
import { useEffect, useMemo, useState } from "react";

import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";
import {
  githubIssueResourceKey,
  loadGitHubDetailAuthScope,
  loadGitHubIssueTimeline,
  loadGitHubRemoteUrl,
} from "@src/modules/shared/githubIssueDetailCoordinator";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import { fetchIssueTimeline } from "@src/services/git/operations/githubIssues";

import { resolveGitHubIssueRemoteUrl } from "../../../githubIssueRemote";

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

export function useGitHubIssueTimeline({
  enabled,
  repoPath,
  shortId,
}: UseGitHubIssueTimelineOptions): {
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  timelineError: string | null;
} {
  const store = useStore();
  const issueNumber = useMemo(() => parseGitHubIssueNumber(shortId), [shortId]);
  const requestKey =
    enabled && repoPath && issueNumber ? `${repoPath}:${issueNumber}` : "";
  const [state, setState] = useState<GitHubIssueTimelineState | null>(null);
  const currentState = state?.requestKey === requestKey ? state : null;

  useEffect(() => {
    if (!requestKey || !repoPath || !issueNumber) return;

    let cancelled = false;

    void (async () => {
      const [remoteUrl, authScope] = await Promise.all([
        loadGitHubRemoteUrl(store, repoPath, () =>
          resolveGitHubIssueRemoteUrl(repoPath)
        ),
        loadGitHubDetailAuthScope(store),
      ]);
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

      const repoFullName = parseGithubRepoFullName(remoteUrl);
      if (!repoFullName) {
        throw new Error("no_github_remote");
      }
      const resourceKey = githubIssueResourceKey(
        authScope,
        repoFullName,
        issueNumber
      );
      const timeline = await loadGitHubIssueTimeline(
        store,
        resourceKey,
        async () => {
          const result = await fetchIssueTimeline({ remoteUrl, issueNumber });
          if (result.error) throw new Error(result.error);
          return result.data ?? [];
        }
      );
      if (!cancelled) {
        setState({
          requestKey,
          timeline,
          loading: false,
          error: null,
        });
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        setState({
          requestKey,
          timeline: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [issueNumber, repoPath, requestKey, store]);

  return {
    timeline: currentState?.timeline ?? [],
    timelineLoading: Boolean(requestKey) && (currentState?.loading ?? true),
    timelineError: currentState?.error ?? null,
  };
}
