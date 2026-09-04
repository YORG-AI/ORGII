// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIssueLocal: vi.fn(),
  loadGitHubDetailAuthScope: vi.fn(async () => "github.com:connection:user"),
  loadGitHubIssueMetadata: vi.fn(
    async (
      _store: unknown,
      _authScope: string,
      _repoFullName: string,
      _issueNumber: number,
      loader: () => Promise<unknown>
    ) => loader()
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));

vi.mock("@src/api/tauri/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/api/tauri/github")>();
  return { ...actual, getIssueLocal: mocks.getIssueLocal };
});

vi.mock("@src/util/platform/ipcRenderer", () => ({
  openExternalLink: vi.fn(),
}));

vi.mock("@src/modules/shared/githubIssueDetailCoordinator", () => ({
  loadGitHubDetailAuthScope: mocks.loadGitHubDetailAuthScope,
  loadGitHubIssueMetadata: mocks.loadGitHubIssueMetadata,
}));

const { default: GitHubLinkedReferences } = await import(".");

describe("GitHubLinkedReferences", () => {
  it("uses a full-height detail placeholder when there are no references", () => {
    const markup = renderToStaticMarkup(
      createElement(GitHubLinkedReferences, { references: [] })
    );

    expect(markup).toContain("No related items");
    expect(markup).toContain(
      "GitHub issues and pull requests mentioned in this conversation will appear here"
    );
    expect(markup).toContain("min-h-0 h-full w-full min-w-0");
  });

  it("does not request metadata until its Linked panel is enabled", async () => {
    mocks.getIssueLocal.mockResolvedValue({
      id: 9,
      number: 9,
      title: "Resolve on demand",
      body: null,
      state: "open",
      state_reason: null,
      html_url: "https://github.com/acme/app/issues/9",
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
      closed_at: null,
      user: { login: "octocat", avatar_url: "" },
      labels: [],
      assignees: [],
      comments: 0,
      milestone: null,
    });
    const props = {
      references: [
        {
          repoFullName: "acme/app",
          number: 9,
          kind: "issue" as const,
          source: "acme/app#9",
        },
      ],
      defaultRepoFullName: "acme/app",
    };
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(GitHubLinkedReferences, { ...props, enabled: false })
        );
      });
      expect(mocks.getIssueLocal).not.toHaveBeenCalled();
      expect(container.innerHTML).toContain("mx-auto w-full max-w-[932px]");
      expect(container.innerHTML).toContain("px-4 py-4");

      await act(async () => {
        root.render(
          createElement(GitHubLinkedReferences, { ...props, enabled: true })
        );
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(mocks.getIssueLocal).toHaveBeenCalledOnce();
      expect(mocks.loadGitHubDetailAuthScope).toHaveBeenCalledOnce();
      expect(mocks.loadGitHubIssueMetadata).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Resolve on demand");
      expect(
        container.querySelector(
          "[data-testid='github-linked-references-timeline']"
        )
      ).not.toBeNull();
      const card = container.querySelector(
        "[data-testid='github-linked-reference-card']"
      );
      expect(card?.className).toContain("rounded-xl");
      expect(card?.className).toContain("bg-primary-container");
      expect(card?.parentElement?.parentElement?.className).toContain(
        "border-l"
      );
    } finally {
      await act(async () => root.unmount());
      mocks.getIssueLocal.mockReset();
      mocks.loadGitHubDetailAuthScope.mockClear();
      mocks.loadGitHubIssueMetadata.mockClear();
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });
});
