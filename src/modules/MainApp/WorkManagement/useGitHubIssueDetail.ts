import { useCallback, useEffect, useState } from "react";

import type { GitHubIssue, GitHubIssueComment } from "@src/api/tauri/github";
import {
  addIssueComment,
  closeIssue,
  fetchIssueComments,
  reopenIssue,
} from "@src/services/git/operations/githubIssues";

import type { ManagedIssueItem } from "./githubManagedItemModel";

interface GitHubIssueDetailState {
  source: ManagedIssueItem;
  issue: GitHubIssue;
  comments: GitHubIssueComment[];
  commentsLoading: boolean;
  submittingComment: boolean;
  error: string | null;
}

export function useGitHubIssueDetail({
  onDetailViewChange,
}: {
  onDetailViewChange: (open: boolean, onBack: (() => void) | null) => void;
}) {
  const [detail, setDetail] = useState<GitHubIssueDetailState | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  const detailOpen = Boolean(detail);

  useEffect(() => {
    onDetailViewChange(detailOpen, detailOpen ? closeDetail : null);
  }, [closeDetail, detailOpen, onDetailViewChange]);

  useEffect(
    () => () => {
      onDetailViewChange(false, null);
    },
    [onDetailViewChange]
  );

  const openDetail = useCallback((issue: ManagedIssueItem) => {
    setDetail({
      source: issue,
      issue: issue.rawIssue,
      comments: [],
      commentsLoading: true,
      submittingComment: false,
      error: null,
    });

    void fetchIssueComments({
      remoteUrl: issue.remoteUrl,
      issueNumber: issue.id,
    }).then((result) => {
      setDetail((current) => {
        if (current?.issue.html_url !== issue.rawIssue.html_url) return current;
        return {
          ...current,
          comments: result.data ?? [],
          commentsLoading: false,
          error: result.error ?? null,
        };
      });
    });
  }, []);

  const closeCurrentIssue = useCallback(async () => {
    const currentDetail = detail;
    if (!currentDetail) return;
    const result = await closeIssue({
      remoteUrl: currentDetail.source.remoteUrl,
      issueNumber: currentDetail.issue.number,
    });
    setDetail((current) => {
      if (current?.issue.html_url !== currentDetail.issue.html_url)
        return current;
      return result.data
        ? { ...current, issue: result.data, error: null }
        : { ...current, error: result.error };
    });
  }, [detail]);

  const reopenCurrentIssue = useCallback(async () => {
    const currentDetail = detail;
    if (!currentDetail) return;
    const result = await reopenIssue({
      remoteUrl: currentDetail.source.remoteUrl,
      issueNumber: currentDetail.issue.number,
    });
    setDetail((current) => {
      if (current?.issue.html_url !== currentDetail.issue.html_url)
        return current;
      return result.data
        ? { ...current, issue: result.data, error: null }
        : { ...current, error: result.error };
    });
  }, [detail]);

  const addComment = useCallback(
    async (body: string) => {
      const currentDetail = detail;
      if (!currentDetail) return;
      setDetail((current) =>
        current?.issue.html_url === currentDetail.issue.html_url
          ? { ...current, submittingComment: true }
          : current
      );
      const result = await addIssueComment({
        remoteUrl: currentDetail.source.remoteUrl,
        issueNumber: currentDetail.issue.number,
        body,
      });
      if (result.data) {
        const comment = result.data;
        setDetail((current) =>
          current?.issue.html_url === currentDetail.issue.html_url
            ? {
                ...current,
                issue: {
                  ...current.issue,
                  comments: current.issue.comments + 1,
                },
                comments: [...current.comments, comment],
                submittingComment: false,
                error: null,
              }
            : current
        );
        return;
      }
      setDetail((current) =>
        current?.issue.html_url === currentDetail.issue.html_url
          ? { ...current, submittingComment: false, error: result.error }
          : current
      );
      throw new Error(result.error);
    },
    [detail]
  );

  return {
    detail,
    detailOpen,
    closeDetail,
    openDetail,
    closeCurrentIssue,
    reopenCurrentIssue,
    addComment,
  };
}
