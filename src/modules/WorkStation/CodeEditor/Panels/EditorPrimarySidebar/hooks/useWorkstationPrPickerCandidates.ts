/**
 * useWorkstationPrPickerCandidates
 *
 * Candidate lists behind the PR details rail's people and label pickers. The
 * repository assignee list backs both the reviewer and assignee pickers, so it
 * is fetched at most once per resolved repository and shared between them —
 * reviewers exclude the PR author (GitHub rejects self-review), assignees do
 * not. Labels are fetched separately, and only when their picker is opened.
 * Every list resets when the repository changes.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type GitHubIssueLabel,
  type GitHubIssueUser,
  listRepoAssigneesLocal,
  listRepoLabelsLocal,
} from "@src/api/tauri/github";

export interface UseWorkstationPrPickerCandidatesOptions {
  repoFullName: string | null;
  /** Login of the PR author, excluded from the reviewer candidate list. */
  latestAuthorLoginRef: React.MutableRefObject<string | null>;
}

export function useWorkstationPrPickerCandidates({
  repoFullName,
  latestAuthorLoginRef,
}: UseWorkstationPrPickerCandidatesOptions) {
  const peopleAttemptedRef = useRef(false);
  const [peopleCandidates, setPeopleCandidates] = useState<GitHubIssueUser[]>(
    []
  );
  const [loadingReviewerCandidates, setLoadingReviewerCandidates] =
    useState(false);
  const [reviewerCandidatesError, setReviewerCandidatesError] = useState<
    string | null
  >(null);

  const labelsAttemptedRef = useRef(false);
  const [labelCandidates, setLabelCandidates] = useState<GitHubIssueLabel[]>(
    []
  );
  const [loadingLabelCandidates, setLoadingLabelCandidates] = useState(false);
  const [labelCandidatesError, setLabelCandidatesError] = useState<
    string | null
  >(null);

  useEffect(() => {
    peopleAttemptedRef.current = false;
    setPeopleCandidates([]);
    setLoadingReviewerCandidates(false);
    setReviewerCandidatesError(null);
    labelsAttemptedRef.current = false;
    setLabelCandidates([]);
    setLoadingLabelCandidates(false);
    setLabelCandidatesError(null);
  }, [repoFullName]);

  const loadReviewerCandidates = useCallback(async (): Promise<void> => {
    if (!repoFullName || peopleAttemptedRef.current) return;
    peopleAttemptedRef.current = true;
    setLoadingReviewerCandidates(true);
    setReviewerCandidatesError(null);
    try {
      setPeopleCandidates(await listRepoAssigneesLocal(repoFullName));
    } catch (error) {
      peopleAttemptedRef.current = false;
      setReviewerCandidatesError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setLoadingReviewerCandidates(false);
    }
  }, [repoFullName]);

  const loadLabelCandidates = useCallback(async (): Promise<void> => {
    if (!repoFullName || labelsAttemptedRef.current) return;
    labelsAttemptedRef.current = true;
    setLoadingLabelCandidates(true);
    setLabelCandidatesError(null);
    try {
      setLabelCandidates(await listRepoLabelsLocal(repoFullName));
    } catch (error) {
      labelsAttemptedRef.current = false;
      setLabelCandidatesError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setLoadingLabelCandidates(false);
    }
  }, [repoFullName]);

  const authorLogin = latestAuthorLoginRef.current?.toLowerCase();
  const reviewerCandidates = peopleCandidates.filter(
    (candidate) => candidate.login.toLowerCase() !== authorLogin
  );

  return {
    reviewerCandidates,
    /** The author can be assigned to their own pull request. */
    assigneeCandidates: peopleCandidates,
    loadingReviewerCandidates,
    reviewerCandidatesError,
    loadReviewerCandidates,
    labelCandidates,
    loadingLabelCandidates,
    labelCandidatesError,
    loadLabelCandidates,
  };
}
