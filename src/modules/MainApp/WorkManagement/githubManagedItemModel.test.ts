import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

import {
  GITHUB_ITEM_KIND,
  formatGitHubItemTimeAgo,
  managedItemMatchesQuery,
  managedItemMatchesRepo,
  mapIssueToManagedItem,
  mapPrToManagedItem,
} from "./githubManagedItemModel";
import { parseGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";

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
  updated_at: "2026-07-20T11:59:00.000Z",
  comments: 2,
  linked_pull_requests_count: 3,
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [{ login: "viewer" }],
  user: { login: "author", avatar_url: "avatar" },
} as GitHubIssue;
const pr = {
  number: 7,
  title: "Ship fix",
  state: "merged",
  updated_at: "2026-07-20T11:00:00.000Z",
  head_branch: "fix/crash",
  base_branch: "main",
  draft: false,
} as OpenPRItem;

describe("GitHub managed-item model", () => {
  it("maps issues and PRs to the shared list shape", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    expect(mapIssueToManagedItem(issue, source)).toMatchObject({
      kind: GITHUB_ITEM_KIND.ISSUE,
      id: 42,
      repo: "acme/repo",
      author: "author",
      timeAgo: "1m ago",
      linkedPullRequests: 3,
    });
    expect(mapPrToManagedItem(pr, source)).toMatchObject({
      kind: GITHUB_ITEM_KIND.PR,
      id: 7,
      sourceBranch: "fix/crash",
      targetBranch: "main",
      timeAgo: "1h ago",
    });
    vi.useRealTimers();
  });

  it("matches repository, @me, labels, state, and free text", () => {
    const item = mapIssueToManagedItem(issue, source);
    expect(managedItemMatchesRepo(item, "acme/repo", "all")).toBe(true);
    expect(managedItemMatchesRepo(item, "other/repo", "all")).toBe(false);
    expect(
      managedItemMatchesQuery(
        item,
        parseGitHubSearchQuery("is:issue is:open assignee:@me label:bug crash")
      )
    ).toBe(true);
    expect(
      managedItemMatchesQuery(item, parseGitHubSearchQuery("author:someone"))
    ).toBe(false);
  });

  it("preserves merged PR query semantics and time boundaries", () => {
    const item = mapPrToManagedItem(pr, source);
    expect(
      managedItemMatchesQuery(item, parseGitHubSearchQuery("is:pr is:merged"))
    ).toBe(true);
    expect(formatGitHubItemTimeAgo("invalid", 0)).toBe("");
  });
});
