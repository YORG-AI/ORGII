import { describe, expect, it } from "vitest";

import {
  GITHUB_ITEM_KIND,
  type ManagedIssueItem,
  type ManagedPrItem,
} from "./githubManagedItemModel";
import {
  canManageIssueAssignees,
  canManageIssueStatus,
  canManagePrStatus,
} from "./githubWorkItemPermissions";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";

const source = {
  permissions: {
    role_name: "read",
    can_manage_issues: false,
    can_manage_pull_requests: false,
  },
} as GitHubRepoSource;

const issue = {
  kind: GITHUB_ITEM_KIND.ISSUE,
  author: "author",
  viewerLogin: "viewer",
} as ManagedIssueItem;

const pullRequest = {
  kind: GITHUB_ITEM_KIND.PR,
  authoredByViewer: false,
} as ManagedPrItem;

describe("GitHub work-item permissions", () => {
  it("keeps assignee editing repository-role gated", () => {
    expect(canManageIssueAssignees(source)).toBe(false);
    expect(
      canManageIssueAssignees({
        ...source,
        permissions: { ...source.permissions!, can_manage_issues: true },
      })
    ).toBe(true);
  });

  it("allows issue authors to update status but not assignees", () => {
    const authoredIssue = { ...issue, viewerLogin: "AUTHOR" };
    expect(canManageIssueStatus(authoredIssue, source)).toBe(true);
    expect(canManageIssueAssignees(source)).toBe(false);
  });

  it("allows PR authors to update status and treats unknown access as readonly", () => {
    expect(
      canManagePrStatus({ ...pullRequest, authoredByViewer: true }, source)
    ).toBe(true);
    expect(canManagePrStatus(pullRequest, undefined)).toBe(false);
    expect(canManageIssueAssignees(undefined)).toBe(false);
  });
});
