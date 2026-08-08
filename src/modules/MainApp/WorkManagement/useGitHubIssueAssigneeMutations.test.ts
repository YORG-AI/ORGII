import { describe, expect, it } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";

import {
  GITHUB_ITEM_KIND,
  type ManagedIssueItem,
} from "./githubManagedItemModel";
import {
  issueHasAssigneeLogins,
  resolveIssueAssigneeUsers,
} from "./useGitHubIssueAssigneeMutations";

const issue: GitHubIssue = {
  id: 100_681,
  number: 681,
  title: "Keep the assignee avatar current",
  body: null,
  state: "open",
  state_reason: null,
  html_url: "https://github.com/org2ai/ORG2/issues/681",
  created_at: "2026-08-05T10:00:00Z",
  updated_at: "2026-08-05T10:00:00Z",
  closed_at: null,
  user: { login: "author", avatar_url: "" },
  labels: [],
  assignees: [
    { login: "previous", avatar_url: "https://example.com/previous.png" },
  ],
  comments: 0,
  linked_pull_requests_count: 0,
  milestone: null,
};

const item: ManagedIssueItem = {
  kind: GITHUB_ITEM_KIND.ISSUE,
  id: issue.number,
  title: issue.title,
  repo: "org2ai/ORG2",
  repoPath: "/workspace/ORG2",
  remoteUrl: "https://github.com/org2ai/ORG2.git",
  viewerLogin: "viewer",
  rawIssue: issue,
  author: "author",
  timeAgo: "now",
  state: "open",
  labels: [],
  comments: 0,
  linkedPullRequests: 0,
  updatedAt: issue.updated_at,
};

describe("GitHub issue assignee updates", () => {
  it("resolves optimistic assignees with collaborator avatars", () => {
    expect(
      resolveIssueAssigneeUsers(
        item,
        [
          {
            login: "Neonforge98",
            avatar_url: "https://example.com/neonforge.png",
          },
        ],
        ["Neonforge98"]
      )
    ).toEqual([
      {
        login: "Neonforge98",
        avatar_url: "https://example.com/neonforge.png",
      },
    ]);
  });

  it("detects when GitHub returns assignees different from the request", () => {
    expect(
      issueHasAssigneeLogins(
        {
          ...issue,
          assignees: [
            { login: "Second", avatar_url: "" },
            { login: "FIRST", avatar_url: "" },
          ],
        },
        ["first", "second"]
      )
    ).toBe(true);
    expect(issueHasAssigneeLogins(issue, ["Neonforge98"])).toBe(false);
  });
});
