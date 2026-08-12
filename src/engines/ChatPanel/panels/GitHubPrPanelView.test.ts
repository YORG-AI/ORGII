import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel",
  () => ({
    PrDetailPanel: ({
      combineHeaderAndTabs,
      headerClassName,
    }: {
      combineHeaderAndTabs?: boolean;
      headerClassName?: string;
    }) =>
      createElement("div", {
        "data-testid": "pr",
        "data-combine-header-tabs": String(combineHeaderAndTabs),
        "data-header-class-name": headerClassName,
      }),
  })
);

const { GitHubPrPanelView } = await import("./GitHubPrPanelView");

describe("GitHubPrPanelView", () => {
  it("aligns the PR header with the chat tab icon", () => {
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

    expect(markup).toContain('data-header-class-name="!pl-5 !pr-[7px]"');
    expect(markup).toContain('data-combine-header-tabs="true"');
  });
});
