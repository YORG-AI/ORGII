import { describe, expect, it } from "vitest";

import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

import { parseGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";
import { deriveGitHubWorkItemsState } from "./useGitHubWorkItemsDerivedState";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
} from "./useGitHubWorkItemsLoadLifecycle";

const source: GitHubRepoSource = {
  repoId: "repo-1",
  repoPath: "/repo",
  label: "repo",
  remoteUrl: "https://github.com/acme/repo.git",
  repoFullName: "acme/repo",
  viewerLogin: "viewer",
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
  title: "Ship fix",
  state: "merged",
  updated_at: "2026-07-20T11:00:00.000Z",
  head_branch: "fix/crash",
  base_branch: "main",
  draft: false,
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
    allReposValue: "all",
    currentWorkstationValue: "currentWorkstation",
  });
}

describe("GitHub work-items derived state", () => {
  it("resolves current workstation and invalid repo selections", () => {
    expect(derive("currentWorkstation", "/repo")).toMatchObject({
      effectiveSelectedRepo: "acme/repo",
      selectedRepoSourceForCreate: source,
    });
    expect(derive("missing/repo", null).effectiveSelectedRepo).toBe("all");
  });

  it("projects sorted items, state counts, and remote pagination", () => {
    const state = derive("all", "/repo");
    expect(state.allItems.map((item) => item.id)).toEqual([42, 7]);
    expect(state.issueStateCounts).toEqual({ open: 1, closed: 0 });
    expect(state.closedPrCount).toBe(1);
    expect(state.hasMoreFilteredIssues).toBe(true);
    expect(state.openIssuesLoaded).toBe(true);
    expect(state.closedIssuesLoaded).toBe(false);
  });
});
