import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  IssuePersonalFilterDropdown,
  ManagedIssueRow,
  ManagedPrRow,
  RepoFilterPill,
} from "./GitHubWorkItemControls";
import {
  GITHUB_ITEM_KIND,
  type ManagedIssueItem,
  type ManagedPrItem,
} from "./githubWorkItemsModel";

const linkedIssue: ManagedIssueItem = {
  kind: GITHUB_ITEM_KIND.ISSUE,
  id: 42,
  title: "Fix linked pull request visibility",
  repo: "yorgai/ORG2",
  repoPath: "/workspace/ORG2",
  remoteUrl: "https://github.com/yorgai/ORG2.git",
  viewerLogin: "viewer",
  rawIssue: {
    number: 42,
    title: "Fix linked pull request visibility",
    body: null,
    state: "open",
    state_reason: null,
    html_url: "https://github.com/yorgai/ORG2/issues/42",
    created_at: "2026-07-21T08:00:00Z",
    updated_at: "2026-07-21T08:10:00Z",
    closed_at: null,
    user: { login: "junyu", avatar_url: "https://example.com/avatar.png" },
    labels: [],
    assignees: [],
    comments: 4,
    linked_pull_requests_count: 2,
    milestone: null,
  },
  author: "junyu",
  timeAgo: "10m ago",
  state: "open",
  labels: [],
  comments: 4,
  linkedPullRequests: 2,
  updatedAt: "2026-07-21T08:10:00Z",
};

const draftPr: ManagedPrItem = {
  kind: GITHUB_ITEM_KIND.PR,
  id: 465,
  title: "Consolidate audited workspace refactors",
  repo: "yorgai/ORG2",
  repoId: "repo-1",
  repoPath: "/workspace/ORG2",
  remoteUrl: "https://github.com/yorgai/ORG2.git",
  rawPr: {
    number: 465,
    url: "https://github.com/yorgai/ORG2/pull/465",
    title: "Consolidate audited workspace refactors",
    state: "open",
    head_branch: "audit-workspace",
    base_branch: "develop",
    draft: true,
    created_at: "2026-07-21T08:00:00Z",
    updated_at: "2026-07-21T08:10:00Z",
  },
  author: "junyu",
  timeAgo: "10m ago",
  state: "open",
  sourceBranch: "audit-workspace",
  targetBranch: "develop",
  updatedAt: "2026-07-21T08:10:00Z",
};

describe("ManagedPrRow", () => {
  it("uses the GitHub draft icon without a Draft tag", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedPrRow, {
        pr: draftPr,
        addLabel: "Add",
        onOpenPr: vi.fn(),
        onAddPr: vi.fn(),
      })
    );

    expect(markup).toContain("lucide-git-pull-request-draft");
    expect(markup).not.toContain(">Draft<");
  });
});

describe("ManagedIssueRow", () => {
  it("shows linked pull requests alongside the comment count", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedIssueRow, {
        issue: linkedIssue,
        addLabel: "Add",
        openInBrowserLabel: "Open in browser",
        openInMyStationLabel: "Open in My Station",
        moreActionsLabel: "More actions",
        onOpenIssue: vi.fn(),
        onOpenIssueInBrowser: vi.fn(),
        onOpenIssueInMyStation: vi.fn(),
        onAddIssue: vi.fn(),
      })
    );

    expect(markup).toContain('aria-label="2 linked pull requests"');
    expect(markup).toContain("lucide-git-pull-request");
    expect(markup).toContain("lucide-message-square");
  });
});

describe("GitHub work-item header controls", () => {
  it("hugs and shortens the selected repository trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(RepoFilterPill, {
        options: [
          { key: "all", label: "All repositories" },
          { key: "yorgai/ORG2", label: "yorgai/ORG2" },
        ],
        selectedRepo: "yorgai/ORG2",
        allReposLabel: "All repositories",
        onSelectRepo: vi.fn(),
      })
    );

    expect(markup).toContain("lucide-code-xml");
    expect(markup).toContain(">ORG2<");
    expect(markup).not.toContain("yorgai/ORG2");
    expect(markup).toContain("select-ghost");
    expect(markup).toContain("!w-fit shrink-0");
    expect(markup).toContain('style="width:fit-content"');
  });

  it("limits long selected repository names to their first 15 characters", () => {
    const markup = renderToStaticMarkup(
      createElement(RepoFilterPill, {
        options: [
          {
            key: "yorgai/12345678901234567890",
            label: "yorgai/12345678901234567890",
          },
        ],
        selectedRepo: "yorgai/12345678901234567890",
        allReposLabel: "All repositories",
        onSelectRepo: vi.fn(),
      })
    );

    expect(markup).toContain(">123456789012345…<");
  });

  it("renders Filter as a secondary icon-only button", () => {
    const markup = renderToStaticMarkup(
      createElement(IssuePersonalFilterDropdown, {
        options: [{ value: "byMe", label: "Created by me" }],
        selectedFilters: ["byMe"],
        filterLabel: "Filter",
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain("lucide-funnel");
    expect(markup).toContain('aria-label="Filter (1)"');
    expect(markup).not.toContain(">Filter<");
  });
});
