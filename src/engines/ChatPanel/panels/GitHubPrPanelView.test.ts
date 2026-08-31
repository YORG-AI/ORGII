import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel",
  () => ({
    PrDetailPanel: () => createElement("div", { "data-testid": "pr" }),
  })
);

const { GitHubPrPanelView } = await import("./GitHubPrPanelView");

describe("GitHubPrPanelView", () => {
  it("renders the tabs-only PR panel without header layout props", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubPrPanelView, {
        detail: {
          prNumber: 42,
          prTitle: "Align the PR header",
          prUrl: "https://github.com/org/repo/pull/42",
          prStatus: "open",
          repoPath: "/repo",
          headBranch: "feature/alignment",
          baseBranch: "main",
        },
      })
    );

    expect(markup).toContain('data-testid="pr"');
    expect(markup).not.toContain("data-combine-header-tabs");
    expect(markup).not.toContain("data-header-class-name");
  });
});
