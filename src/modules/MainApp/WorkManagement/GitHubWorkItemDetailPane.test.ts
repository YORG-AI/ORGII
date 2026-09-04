// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import GitHubWorkItemDetailPane from "./GitHubWorkItemDetailPane";
import { GITHUB_ITEM_KIND, type ManagedPrItem } from "./githubManagedItemModel";

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel",
  () => ({
    PrDetailPanel: ({ tabActions }: { tabActions?: React.ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": "mock-pr-detail" },
        tabActions
      ),
  })
);

const pullRequest = {
  kind: GITHUB_ITEM_KIND.PR,
  id: 42,
  title: "Open beside the list",
  repo: "orgii/app",
  repoId: "repo-1",
  repoPath: "/workspace/app",
  remoteUrl: "https://github.com/orgii/app.git",
  viewerLogin: "viewer",
  rawPr: {
    number: 42,
    url: "https://github.com/orgii/app/pull/42",
    title: "Open beside the list",
    state: "open",
    author_login: "author",
    author_avatar_url: "",
    requested_reviewer_logins: [],
    head_branch: "feature",
    base_branch: "main",
    draft: false,
    ci_status: "none",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  },
  author: "author",
  authoredByViewer: false,
  reviewRequestedFromViewer: false,
  timeAgo: "1d",
  state: "open",
  sourceBranch: "feature",
  targetBranch: "main",
  updatedAt: "2026-09-01T00:00:00Z",
} as ManagedPrItem;

describe("GitHubWorkItemDetailPane", () => {
  it("keeps dedicated-tab opening as an explicit detail action", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const onOpenPrInNewTab = vi.fn();
    const onClose = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(GitHubWorkItemDetailPane, {
            selectedItem: pullRequest,
            onOpenIssueInNewTab: vi.fn(),
            onOpenPrInNewTab,
            onClose,
          })
        );
      });

      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="work-management-open-in-new-tab"]'
      );
      expect(
        container.querySelector('[data-detail-pane-layout="true"]')
      ).not.toBeNull();
      expect(button).not.toBeNull();
      await act(async () => button?.click());

      expect(onOpenPrInNewTab).toHaveBeenCalledWith(pullRequest);

      const closeButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="work-management-close-detail"]'
      );
      expect(closeButton).not.toBeNull();
      await act(async () => closeButton?.click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });
});
