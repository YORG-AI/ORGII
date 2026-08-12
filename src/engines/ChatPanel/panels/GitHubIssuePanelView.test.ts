import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectedState: {
    issue: null,
    timeline: [],
    loading: false,
    timelineLoading: false,
    error: null,
    submittingComment: false,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/modules/shared/hooks/useGitHubIssueDetailState", () => ({
  useGitHubIssueDetailState: () => ({
    selectedState: mocks.selectedState,
    interaction: {},
    assigneeConfig: undefined,
  }),
}));

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel",
  () => ({
    IssueDetailExternalLinkButton: () =>
      createElement("button", { type: "button" }, "Open on GitHub"),
    IssueDetailPanel: ({ showHeader }: { showHeader?: boolean }) =>
      createElement("div", {
        "data-testid": "issue",
        "data-show-header": String(showHeader),
      }),
  })
);

const { GitHubIssuePanelView } = await import("./GitHubIssuePanelView");

describe("GitHubIssuePanelView loading", () => {
  it("uses the issue skeleton on the cold first render", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubIssuePanelView, {
        detail: {
          issueNumber: 586,
          issueTitle: "Fix initial loading",
          repoPath: "/repo",
          remoteUrl: "https://github.com/org/repo.git",
        },
      })
    );

    expect(markup).toContain('data-testid="github-issue-detail-skeleton"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("animate-spin");
  });

  it("publishes the issue title and suppresses the duplicate internal header", () => {
    Reflect.set(mocks.selectedState, "issue", {
      number: 586,
      title: "Align the issue header",
      state: "open",
      html_url: "https://github.com/org/repo/issues/586",
    });
    try {
      const markup = renderToStaticMarkup(
        createElement(GitHubIssuePanelView, {
          detail: {
            issueNumber: 586,
            issueTitle: "Align the issue header",
            repoPath: "/repo",
          },
        })
      );

      expect(markup).toContain('data-show-header="false"');
    } finally {
      Reflect.set(mocks.selectedState, "issue", null);
    }
  });
});
