/**
 * useSubmissionsData
 *
 * Single entry point for every Submissions-tab data source on the Diff app:
 *
 * 1. Backend diff replay preview (`getOrgtrackDiffReplayPreview`) for
 *    orgtrack final diffs and orgtrack-created submission commits.
 * 2. Git history commit resolution (`getGitCommits` + `getGitCommitDiff`
 *    fallback) — upgrades short SHAs to full SHAs and attaches real
 *    author/summary to commits surfaced by orgtrack or by chat/shell
 *    extraction.
 * 4. GitHub PR status (`getPRLocal`) — batch-fetched once per session and
 *    keyed by `repoFullName#prNumber` so duplicate rows share one request.
 *
 * Previously each of these was its own `useEffect` + `useState` pair living
 * in `SessionReplay/index.tsx`, with hand-written cancellation tokens and
 * cross-effect derivation chains. Consolidating them into one hook removes
 * four effect templates from the host component and makes the lifecycle
 * (session change → fetches kick off → derived rows resolve) read top to
 * bottom in one place.
 */
import { useEffect, useMemo, useState } from "react";

import { getGitCommitDiff, getGitCommits } from "@src/api/http/git";
import type { CommitDiffResult, GitCommitInfo } from "@src/api/http/git/types";
import { getPRLocal } from "@src/api/tauri/github";
import {
  type OrgtrackSessionFinalDiff,
  getOrgtrackDiffReplayPreview,
} from "@src/api/tauri/lineage";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { loadEvents } from "@src/engines/SessionCore/storage/cacheAdapter";
import { createLogger } from "@src/hooks/logger";
import { normalizePrStatus } from "@src/shared/pr/prStatus";
import type { Repo } from "@src/store/repo/types";

import {
  type PullRequestSubmission,
  type SubmissionCommit,
  type SubmissionsData,
  deriveSubmissionsData,
} from "./SubmissionsContent";
import {
  type SubmissionRepoContext,
  collectSubmissionArtifacts,
} from "./submissionsArtifacts";

export type { SubmissionRepoContext } from "./submissionsArtifacts";

const logger = createLogger("useSubmissionsData");

const SUBMISSION_COMMIT_RESOLVE_LIMIT = 200;

interface UseSubmissionsDataParams {
  sessionId: string | undefined;
  simulatorEvents: readonly SessionEvent[];
  fallbackRepoContext: SubmissionRepoContext;
  repos: readonly Repo[];
  /** Bumped on every chat→Diff navigation; forces a re-load of orgtrack
   * commit links so a just-edited working tree isn't shown stale. */
  diffRefreshNonce: number;
}

export interface UseSubmissionsDataResult {
  /** Canonical orgtrack-derived per-file diff list. */
  orgtrackFinalDiffs: OrgtrackSessionFinalDiff[];
  orgtrackFinalDiffsLoading: boolean;
  /** Dedup'd, resolved commit rows (orgtrack + shell-created + mention),
   * with author/summary upgraded from git history when possible. */
  submissionCommits: SubmissionCommit[];
  /** PR rows with normalized GitHub status injected via `statusKey`. */
  pullRequestsWithStatus: PullRequestSubmission[];
  /** Raw `deriveSubmissionsData` output; exposed because the count-only
   * consumers (tab badge, hasSubmissions) prefer it over the
   * status-injected variant to avoid count flicker on status resolve. */
  submissionsData: SubmissionsData;
}

function getRepoContextKey(context: SubmissionRepoContext): string | null {
  return context.repoPath ?? context.repoId ?? null;
}

function commitMatchesSubmission(
  candidate: GitCommitInfo,
  submission: SubmissionCommit
): boolean {
  const sha = submission.sha.toLowerCase();
  return (
    candidate.sha.toLowerCase().startsWith(sha) ||
    candidate.short_sha.toLowerCase() === sha
  );
}

function commitDiffToCommitInfo(diff: CommitDiffResult): GitCommitInfo {
  // The direct-SHA fallback only needs the fields `mergeResolvedCommit` reads:
  // sha / short_sha / summary / author. Everything else is filled with safe
  // defaults so callers that incidentally read them don't crash.
  return {
    sha: diff.commit_sha,
    short_sha: diff.short_sha,
    summary: diff.summary,
    body: diff.body,
    author: diff.author ?? {
      name: "",
      email: "",
      date: "",
    },
    committer: diff.committer ?? {
      name: "",
      email: "",
      date: "",
    },
    parent_shas: diff.parent_shas,
  };
}

function mergeResolvedCommit(
  submission: SubmissionCommit,
  resolved: GitCommitInfo | undefined,
  context: SubmissionRepoContext
): SubmissionCommit {
  if (!resolved) {
    return {
      ...submission,
      repoId: submission.repoId ?? context.repoId,
      repoPath: submission.repoPath ?? context.repoPath,
      origin: submission.origin,
    };
  }

  return {
    ...submission,
    sha: resolved.sha,
    short_sha: resolved.short_sha,
    summary: resolved.summary,
    author: resolved.author,
    // The commit was actually found in `context`'s git history, so that
    // context is authoritative — the submission's own repo context may be
    // a wrong session-level fallback (e.g. a non-git working directory).
    repoId: context.repoId ?? submission.repoId,
    repoPath: context.repoPath ?? submission.repoPath,
    origin: submission.origin,
  };
}

export function useSubmissionsData({
  sessionId,
  simulatorEvents,
  fallbackRepoContext,
  repos,
  diffRefreshNonce,
}: UseSubmissionsDataParams): UseSubmissionsDataResult {
  // ─────────────────────── backend replay preview ───────────────────────
  const [orgtrackFinalDiffs, setOrgtrackFinalDiffs] = useState<
    OrgtrackSessionFinalDiff[]
  >([]);
  const [orgtrackFinalDiffsLoading, setOrgtrackFinalDiffsLoading] =
    useState(false);
  const [orgtrackSubmissionCommits, setOrgtrackSubmissionCommits] = useState<
    SubmissionCommit[]
  >([]);
  const [cachedSessionEvents, setCachedSessionEvents] = useState<
    SessionEvent[]
  >([]);

  useEffect(() => {
    if (!sessionId) {
      setOrgtrackFinalDiffs([]);
      setOrgtrackSubmissionCommits([]);
      return;
    }

    let cancelled = false;
    setOrgtrackFinalDiffsLoading(true);
    void getOrgtrackDiffReplayPreview({
      sessionId,
      repoId: fallbackRepoContext.repoId,
      repoPath: fallbackRepoContext.repoPath,
    })
      .then((preview) => {
        if (cancelled) return;
        setOrgtrackFinalDiffs(preview.finalDiffs);
        setOrgtrackSubmissionCommits(preview.submissionCommits);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          logger.warn("failed to load orgtrack diff replay preview", {
            err,
            sessionId,
          });
          setOrgtrackFinalDiffs([]);
          setOrgtrackSubmissionCommits([]);
        }
      })
      .finally(() => {
        if (!cancelled) setOrgtrackFinalDiffsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    diffRefreshNonce,
    fallbackRepoContext.repoId,
    fallbackRepoContext.repoPath,
  ]);

  useEffect(() => {
    if (!sessionId) {
      setCachedSessionEvents([]);
      return;
    }

    let cancelled = false;
    void loadEvents(sessionId)
      .then((events) => {
        if (!cancelled) setCachedSessionEvents(events);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          logger.warn("failed to load full session events for submissions", {
            err,
            sessionId,
          });
          setCachedSessionEvents([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // ─────────────── derived: union of every commit submission ───────────────
  const submissionsData = useMemo(() => {
    const eventById = new Map<string, SessionEvent>();
    for (const event of cachedSessionEvents) eventById.set(event.id, event);
    for (const event of simulatorEvents) eventById.set(event.id, event);
    return deriveSubmissionsData(
      collectSubmissionArtifacts(
        Array.from(eventById.values()),
        fallbackRepoContext
      )
    );
  }, [cachedSessionEvents, fallbackRepoContext, simulatorEvents]);

  const createdShellSubmissionCommits = useMemo<SubmissionCommit[]>(
    () => submissionsData.commits.filter((c) => c.origin === "created"),
    [submissionsData.commits]
  );
  const mentionedSubmissionCommits = useMemo<SubmissionCommit[]>(
    () => submissionsData.commits.filter((c) => c.origin === "mentioned"),
    [submissionsData.commits]
  );

  // Union of all commit sources that the git-history resolve effect should
  // upgrade with author/summary. Dedupe is **prefix-aware**: a 7-char short
  // SHA from text/shell extraction and the matching full 40-char SHA from
  // orgtrack are the same commit; if we only matched by `===` the sidebar
  // ends up with two rows for one commit (one short, one full) — and once
  // resolve upgrades the short row to its full SHA, both rows carry the same
  // `sha` and selecting one row visually selects both.
  const unresolvedSubmissionCommits = useMemo<SubmissionCommit[]>(() => {
    const ordered: SubmissionCommit[] = [];
    const push = (incoming: SubmissionCommit) => {
      const sha = incoming.sha?.toLowerCase();
      if (!sha) return;
      for (let index = 0; index < ordered.length; index += 1) {
        const existing = ordered[index].sha?.toLowerCase();
        if (!existing) continue;
        if (existing === sha) return;
        if (sha.startsWith(existing) || existing.startsWith(sha)) {
          // Keep the longer (more authoritative) SHA; otherwise keep first.
          if (sha.length > existing.length) ordered[index] = incoming;
          return;
        }
      }
      ordered.push(incoming);
    };
    for (const commit of orgtrackSubmissionCommits) push(commit);
    for (const commit of createdShellSubmissionCommits) push(commit);
    for (const commit of mentionedSubmissionCommits) push(commit);
    return ordered;
  }, [
    orgtrackSubmissionCommits,
    createdShellSubmissionCommits,
    mentionedSubmissionCommits,
  ]);

  // ─────────── git-history resolve: upgrade author + full SHA ───────────
  const [resolvedSubmissionCommits, setResolvedSubmissionCommits] = useState<
    SubmissionCommit[]
  >([]);
  const [resolvedForCommits, setResolvedForCommits] = useState<
    SubmissionCommit[] | null
  >(null);
  const submissionsResolved =
    resolvedForCommits === unresolvedSubmissionCommits;

  useEffect(() => {
    let cancelled = false;

    async function resolveSubmissionsAgainstGitHistory() {
      const resolvedByContextKey = new Map<string, GitCommitInfo[]>();

      async function loadHistory(
        context: SubmissionRepoContext,
        contextKey: string
      ): Promise<GitCommitInfo[]> {
        let commits = resolvedByContextKey.get(contextKey);
        if (commits) return commits;
        const result = await getGitCommits({
          repo_id: context.repoId ?? context.repoPath ?? "",
          repo_path: context.repoPath,
          limit: SUBMISSION_COMMIT_RESOLVE_LIMIT,
        });
        commits = result?.commits ?? [];
        resolvedByContextKey.set(contextKey, commits);
        return commits;
      }

      const nextCommits = await Promise.all(
        unresolvedSubmissionCommits.map(async (submission) => {
          const primaryContext = {
            repoId: submission.repoId ?? fallbackRepoContext.repoId,
            repoPath: submission.repoPath ?? fallbackRepoContext.repoPath,
          };

          // The session's repo context can point at a non-git working
          // directory (or the wrong repo). Search the primary context first,
          // then fall back to every known workspace repo so the commit card
          // resolves to the repo that owns the SHA.
          const candidateContexts: SubmissionRepoContext[] = [];
          const seenKeys = new Set<string>();
          const pushCandidate = (context: SubmissionRepoContext) => {
            const key = getRepoContextKey(context);
            if (!key || seenKeys.has(key)) return;
            seenKeys.add(key);
            candidateContexts.push(context);
          };
          pushCandidate(primaryContext);
          for (const repo of repos) {
            const path = repo.fs_uri ?? repo.path;
            if (path) pushCandidate({ repoId: repo.id, repoPath: path });
          }

          if (candidateContexts.length === 0) {
            return mergeResolvedCommit(submission, undefined, primaryContext);
          }

          for (const context of candidateContexts) {
            const contextKey = getRepoContextKey(context);
            if (!contextKey) continue;
            const commits = await loadHistory(context, contextKey);
            const resolvedCommit = commits.find((candidate) =>
              commitMatchesSubmission(candidate, submission)
            );
            if (resolvedCommit) {
              return mergeResolvedCommit(submission, resolvedCommit, context);
            }
          }

          // The HEAD-walk above misses commits on branches not reachable from
          // the current HEAD (e.g. a `Merge ORGII-dev into main` commit when
          // we're on `ORGII-dev`). Fall back to a direct SHA lookup which
          // resolves any commit object regardless of branch reachability.
          for (const context of candidateContexts) {
            const contextKey = getRepoContextKey(context);
            if (!contextKey) continue;
            const directDiff = await getGitCommitDiff({
              repo_id: context.repoId ?? context.repoPath ?? "",
              repo_path: context.repoPath,
              commit_sha: submission.sha,
            });
            if (directDiff) {
              return mergeResolvedCommit(
                submission,
                commitDiffToCommitInfo(directDiff),
                context
              );
            }
          }

          return mergeResolvedCommit(submission, undefined, primaryContext);
        })
      );

      if (!cancelled) {
        setResolvedSubmissionCommits(nextCommits);
        setResolvedForCommits(unresolvedSubmissionCommits);
      }
    }

    void resolveSubmissionsAgainstGitHistory();

    return () => {
      cancelled = true;
    };
  }, [fallbackRepoContext, unresolvedSubmissionCommits, repos]);

  const submissionCommits = useMemo(() => {
    // `resolvedSubmissionCommits` already covers all three sources because
    // they are funnelled through `unresolvedSubmissionCommits` before resolve.
    // While the first resolve is in flight we fall back to the union itself
    // so the sidebar isn't empty for the first frame. Final exact-match
    // dedupe handles the rare case where resolve upgrades a short SHA to a
    // full SHA that already existed in the union.
    const source = submissionsResolved
      ? resolvedSubmissionCommits
      : resolvedSubmissionCommits.length > 0
        ? resolvedSubmissionCommits
        : unresolvedSubmissionCommits;
    const seen = new Set<string>();
    const deduped: SubmissionCommit[] = [];
    for (const commit of source) {
      const sha = commit.sha?.toLowerCase();
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      deduped.push(commit);
    }
    return deduped;
  }, [
    resolvedSubmissionCommits,
    unresolvedSubmissionCommits,
    submissionsResolved,
  ]);

  // ─────────── PR status: batch fetch, inject `statusKey` ───────────
  const [prStatusByKey, setPrStatusByKey] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const prStatusFetchKey = useMemo(() => {
    const keys: string[] = [];
    for (const pr of submissionsData.pullRequests) {
      if (pr.repoFullName && pr.prNumber) {
        keys.push(`${pr.repoFullName}#${pr.prNumber}`);
      }
    }
    keys.sort();
    return keys.join("|");
  }, [submissionsData.pullRequests]);

  useEffect(() => {
    if (!prStatusFetchKey) {
      setPrStatusByKey(new Map());
      return;
    }
    let cancelled = false;
    const targets = new Map<
      string,
      { repoFullName: string; prNumber: number }
    >();
    for (const pr of submissionsData.pullRequests) {
      if (!pr.repoFullName || !pr.prNumber) continue;
      const key = `${pr.repoFullName}#${pr.prNumber}`;
      if (!targets.has(key)) {
        targets.set(key, {
          repoFullName: pr.repoFullName,
          prNumber: pr.prNumber,
        });
      }
    }

    void Promise.all(
      Array.from(targets.entries()).map(
        async ([key, { repoFullName, prNumber }]) => {
          try {
            const pr = await getPRLocal(repoFullName, prNumber);
            const state =
              typeof pr.state === "string" ? (pr.state as string) : undefined;
            const merged = pr.merged === true;
            const draft = pr.draft === true;
            return [key, normalizePrStatus({ state, merged, draft })] as const;
          } catch (error) {
            // Status is cosmetic; a failed fetch (no creds, rate limit, private
            // repo, network) shouldn't break the row. Skip — row falls back to
            // "open" via `pullRequest.statusKey ?? "open"`.
            logger.warn("failed to fetch PR status", {
              error,
              repoFullName,
              prNumber,
            });
            return null;
          }
        }
      )
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const entry of entries) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setPrStatusByKey(next);
    });

    return () => {
      cancelled = true;
    };
    // `prStatusFetchKey` already encodes the identity of every PR row;
    // depending on it (instead of the full array) avoids re-fetching when
    // upstream merely produces a new array reference with the same contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prStatusFetchKey]);

  const pullRequestsWithStatus = useMemo(() => {
    if (prStatusByKey.size === 0) return submissionsData.pullRequests;
    return submissionsData.pullRequests.map((pr) => {
      if (!pr.repoFullName || !pr.prNumber) return pr;
      const status = prStatusByKey.get(`${pr.repoFullName}#${pr.prNumber}`);
      return status ? { ...pr, statusKey: status } : pr;
    });
  }, [submissionsData.pullRequests, prStatusByKey]);

  return {
    orgtrackFinalDiffs,
    orgtrackFinalDiffsLoading,
    submissionCommits,
    pullRequestsWithStatus,
    submissionsData,
  };
}
