import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ManagedPrRow } from "./GitHubWorkItemControls";
import { GITHUB_ITEM_KIND, type ManagedPrItem } from "./githubWorkItemsModel";

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
