import { describe, expect, it } from "vitest";

import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

import { parseGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";
import { deriveGitHubWorkItemsState } from "./useGitHubWorkItemsDerivedState";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
  selectGitHubLoadSources,
} from "./useGitHubWorkItemsLoadLifecycle";

const source: GitHubRepoSource = {
  repoId: "repo-1",
  repoPath: "/repo",
  label: "repo",
  remoteUrl: "https://github.com/acme/repo.git",
  repoFullName: "acme/repo",
  viewerLogin: "viewer",
  permissions: null,
};
const issue = {
  number: 42,
  title: "Fix crash",
  state: "open",
  updated_at: "2026-07-20T12:00:00.000Z",
  comments: 0,
  labels: [],
  assignees: [],
  user: { login: "author", avatar_url: "" },
} as unknown as GitHubIssue;
const mergedPr = {
  number: 7,
  url: "https://github.com/acme/repo/pull/7",
  title: "Ship fix",
  state: "merged",
  author_login: "author",
  author_avatar_url: null,
  requested_reviewer_logins: [],
  updated_at: "2026-07-20T11:00:00.000Z",
  head_branch: "fix/crash",
  base_branch: "main",
  draft: false,
  ci_status: "success",
  created_at: "2026-07-20T10:00:00.000Z",
} as OpenPRItem;

function derive(selectedRepo: string, selectedRepoPath: string | null) {
  return deriveGitHubWorkItemsState({
    repoSources: [source],
    repoIssueMap: {
      [source.repoFullName]: {
        ...EMPTY_REPO_ISSUES,
        openIssues: [issue],
        openLoaded: true,
        openHasMore: true,
        openNextPage: 2,
      },
    },
    repoPrMap: {
      [source.repoFullName]: {
        ...EMPTY_REPO_PRS,
        closedPrs: [mergedPr],
        closedLoaded: true,
      },
    },
    parsedSearchQuery: parseGitHubSearchQuery("state:all"),
    selectedRepo,
    selectedRepoPath,
    currentPage: 1,
  });
}

describe("GitHub work-items derived state", () => {
  it("loads exactly one selected repository and recovers stale selections", () => {
    const secondSource: GitHubRepoSource = {
      ...source,
      repoId: "repo-2",
      repoPath: "/repo-2",
      repoFullName: "acme/repo-2",
    };
    const sources = [source, secondSource];

    expect(
      selectGitHubLoadSources({
        sources,
        selectedRepo: "currentWorkstation",
        selectedRepoPath: "/repo",
      })
    ).toEqual([source]);
    expect(
      selectGitHubLoadSources({
        sources,
        selectedRepo: "acme/repo-2",
        selectedRepoPath: "/repo",
      })
    ).toEqual([secondSource]);
    expect(
      selectGitHubLoadSources({
        sources,
        selectedRepo: "all",
        selectedRepoPath: "/repo",
      })
    ).toEqual([source]);
    expect(
      selectGitHubLoadSources({
        sources,
        selectedRepo: "missing/repo",
        selectedRepoPath: null,
      })
    ).toEqual([source]);
  });

  it("resolves current workstation and invalid repo selections", () => {
    expect(derive("currentWorkstation", "/repo")).toMatchObject({
      effectiveSelectedRepo: "acme/repo",
      selectedRepoSourceForCreate: source,
    });
    expect(derive("missing/repo", null).effectiveSelectedRepo).toBe(
      "acme/repo"
    );
  });

  it("projects sorted items, state counts, and remote pagination", () => {
    const state = derive("acme/repo", "/repo");
    expect(state.allItems.map((item) => item.id)).toEqual([42, 7]);
    expect(state.issueStateCounts).toEqual({ open: 1, closed: 0 });
    expect(state.closedPrCount).toBe(1);
    expect(state.hasMoreFilteredIssues).toBe(true);
    expect(state.openIssuesLoaded).toBe(true);
    expect(state.closedIssuesLoaded).toBe(false);
  });

  it("sorts the loaded result set before slicing the requested page", () => {
    const openIssues = Array.from({ length: 30 }, (_, index) => {
      const id = index + 1;
      const reverseDay = String(30 - index).padStart(2, "0");
      return {
        ...issue,
        number: id,
        updated_at: `2026-07-${reverseDay}T12:00:00.000Z`,
      } as GitHubIssue;
    });
    const input = {
      repoSources: [source],
      repoIssueMap: {
        [source.repoFullName]: {
          ...EMPTY_REPO_ISSUES,
          openIssues,
          openLoaded: true,
        },
      },
      repoPrMap: {},
      parsedSearchQuery: parseGitHubSearchQuery("is:issue is:open"),
      selectedRepo: "acme/repo",
      selectedRepoPath: "/repo",
      currentPage: 2,
    };

    const defaultPage = deriveGitHubWorkItemsState(input);
    expect(defaultPage.pagedItems.map((item) => item.id)).toEqual([
      5, 4, 3, 2, 1,
    ]);

    const updatedPage = deriveGitHubWorkItemsState({
      ...input,
      sort: { column: "updated", order: "descend" },
    });
    expect(updatedPage.pagedItems.map((item) => item.id)).toEqual([
      26, 27, 28, 29, 30,
    ]);
  });

  it("defaults PRs to largest number and supports updated-time sorting", () => {
    const openPr = (
      number: number,
      authorLogin: string,
      requestedReviewerLogins: string[],
      updatedAt: string
    ): OpenPRItem => ({
      ...mergedPr,
      number,
      state: "open",
      author_login: authorLogin,
      requested_reviewer_logins: requestedReviewerLogins,
      updated_at: updatedAt,
    });
    const input = {
      repoSources: [source],
      repoIssueMap: {},
      repoPrMap: {
        [source.repoFullName]: {
          ...EMPTY_REPO_PRS,
          openPrs: [
            openPr(8, "teammate", ["viewer"], "2026-07-20T08:00:00.000Z"),
            openPr(9, "viewer", [], "2026-07-20T10:00:00.000Z"),
            openPr(10, "teammate", [], "2026-07-20T09:00:00.000Z"),
          ],
          openLoaded: true,
          closedPrs: [mergedPr],
          closedLoaded: true,
        },
      },
      parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
      selectedRepo: "acme/repo",
      selectedRepoPath: "/repo",
      currentPage: 1,
    };

    const defaultState = deriveGitHubWorkItemsState(input);
    expect(defaultState.filteredItems.map((item) => item.id)).toEqual([
      10, 9, 8,
    ]);

    const newestFirstState = deriveGitHubWorkItemsState({
      ...input,
      sort: { column: "updated", order: "descend" },
    });
    expect(newestFirstState.filteredItems.map((item) => item.id)).toEqual([
      9, 10, 8,
    ]);

    const oldestFirstState = deriveGitHubWorkItemsState({
      ...input,
      sort: { column: "updated", order: "ascend" },
    });
    expect(oldestFirstState.filteredItems.map((item) => item.id)).toEqual([
      8, 10, 9,
    ]);
  });
});
