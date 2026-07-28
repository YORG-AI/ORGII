/**
 * diffSessionReplay.useCommitNavigation
 *
 * Resolves a chat reference-card commit navigation request
 * (`simulatorDiffCommitNavigationRequestAtom`) against every registered
 * repo's git history and switches the Diff app to the Submissions tab with
 * that commit selected. A commit reached this way may not exist in any
 * submission list (those only carry commits this session actually
 * produced), so the SHA is resolved directly against git rather than
 * against `submissionCommits`.
 *
 * Also owns `handleSubmissionCommitSelect` — the same handler is used both
 * by this resolution effect and by the sidebar's commit-list selection
 * (`useDiffSidebarTab`), so it is exposed from here rather than duplicated.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
} from "react";

import { getGitCommits } from "@src/api/http/git";
import type { Repo } from "@src/store/repo/types";
import type { SimulatorDiffCommitNavigationRequest } from "@src/store/ui/simulatorAtom";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";

import type { SubmissionCommit } from "./SubmissionsContent";
import { getRepoContextKey } from "./diffSessionReplay.repoContext";
import type { DiffReplayTab } from "./types";
import type { SubmissionRepoContext } from "./useSubmissionsData";

const SUBMISSION_COMMIT_RESOLVE_LIMIT = 200;

export interface UseDiffCommitNavigationParams {
  sessionId: string | undefined;
  repos: readonly Repo[];
  fallbackRepoContext: SubmissionRepoContext;
  diffCommitNavigationRequest: SimulatorDiffCommitNavigationRequest | null;
  setDiffCommitNavigationRequest: (
    value: SimulatorDiffCommitNavigationRequest | null
  ) => void;
  setActiveTab: Dispatch<SetStateAction<DiffReplayTab>>;
  setHistorySelection: Dispatch<
    SetStateAction<SourceControlHistorySelection | null>
  >;
  setHistoryRepoContext: Dispatch<
    SetStateAction<{ repoId?: string; repoPath?: string } | null>
  >;
}

export interface UseDiffCommitNavigationResult {
  handleSubmissionCommitSelect: (commit: SubmissionCommit) => void;
}

export function useDiffCommitNavigation({
  sessionId,
  repos,
  fallbackRepoContext,
  diffCommitNavigationRequest,
  setDiffCommitNavigationRequest,
  setActiveTab,
  setHistorySelection,
  setHistoryRepoContext,
}: UseDiffCommitNavigationParams): UseDiffCommitNavigationResult {
  const handleSubmissionCommitSelect = useCallback(
    (commit: SubmissionCommit) => {
      setHistorySelection({
        type: "commit",
        commitSha: commit.sha,
        shortSha: commit.short_sha,
        commitMessage: commit.summary,
      });
      setHistoryRepoContext({
        repoId: commit.repoId,
        repoPath: commit.repoPath,
      });
    },
    [setHistoryRepoContext, setHistorySelection]
  );

  useEffect(() => {
    if (!diffCommitNavigationRequest?.commitSha) return;
    if (
      diffCommitNavigationRequest.sessionId &&
      sessionId &&
      diffCommitNavigationRequest.sessionId !== sessionId
    ) {
      return;
    }

    const requestedSha = diffCommitNavigationRequest.commitSha;
    let cancelled = false;

    // A commit reached via a chat-message reference card may not exist in
    // any submission list (those only carry commits this session actually
    // produced). Resolve the SHA directly against every registered repo's
    // git history so the diff renders regardless of where it was committed.
    const candidateContexts: SubmissionRepoContext[] = [];
    const seenKeys = new Set<string>();
    const pushCandidate = (context: SubmissionRepoContext) => {
      const key = getRepoContextKey(context);
      if (!key || seenKeys.has(key)) return;
      seenKeys.add(key);
      candidateContexts.push(context);
    };
    pushCandidate(fallbackRepoContext);
    for (const repo of repos) {
      const path = repo.fs_uri ?? repo.path;
      if (path) pushCandidate({ repoId: repo.id, repoPath: path });
    }

    async function resolveAndSelect() {
      for (const context of candidateContexts) {
        if (cancelled) return;
        const contextKey = getRepoContextKey(context);
        if (!contextKey) continue;
        const result = await getGitCommits({
          repo_id: context.repoId ?? context.repoPath ?? "",
          repo_path: context.repoPath,
          limit: SUBMISSION_COMMIT_RESOLVE_LIMIT,
        });
        const match = (result?.commits ?? []).find(
          (candidate) =>
            candidate.sha
              .toLowerCase()
              .startsWith(requestedSha.toLowerCase()) ||
            candidate.short_sha.toLowerCase() === requestedSha.toLowerCase()
        );
        if (match) {
          if (cancelled) return;
          setActiveTab("submissions");
          handleSubmissionCommitSelect({
            sha: match.sha,
            short_sha: match.short_sha,
            summary: match.summary,
            author: match.author,
            repoId: context.repoId,
            repoPath: context.repoPath,
          });
          setDiffCommitNavigationRequest(null);
          return;
        }
      }
      // Not found anywhere — clear the request so it doesn't retry forever.
      if (!cancelled) setDiffCommitNavigationRequest(null);
    }

    void resolveAndSelect();

    return () => {
      cancelled = true;
    };
  }, [
    diffCommitNavigationRequest,
    fallbackRepoContext,
    handleSubmissionCommitSelect,
    repos,
    sessionId,
    setActiveTab,
    setDiffCommitNavigationRequest,
  ]);

  return { handleSubmissionCommitSelect };
}
