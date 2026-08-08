// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { type ReactNode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  initialPrDetailViewState,
  initialSelectedPrState,
  workstationPrDetailTabAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { PrDetailPanel } from "./PrDetailPanel";

const childProps = vi.hoisted(() => ({
  changes: null as Record<string, unknown> | null,
  commits: null as Record<string, unknown> | null,
  conversation: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === "string") return fallback;
      if (typeof fallback?.defaultValue !== "string") return key;
      const count = Number(fallback.count ?? 0);
      const template =
        count === 1 || typeof fallback.defaultValue_other !== "string"
          ? fallback.defaultValue
          : fallback.defaultValue_other;
      return template.replace("{{count}}", String(count));
    },
  }),
}));

vi.mock("@src/components/IntegrationIcon", () => ({
  default: () => createElement("span", { "data-testid": "github-icon" }),
}));

vi.mock("../../../hooks/useWorkstationPrDetail", () => ({
  useWorkstationPrDetail: () => ({
    repoFullName: "org/repo",
    addComment: vi.fn(),
    submitReview: vi.fn(),
    replyInlineComment: vi.fn(),
    mergePullRequest: vi.fn(),
    setPullRequestAutoMerge: vi.fn(),
    updatePullRequestState: vi.fn(),
    updateRequestedReviewers: vi.fn(),
    loadReviewerCandidates: vi.fn().mockResolvedValue(undefined),
    reviewerCandidates: [],
    loadingReviewerCandidates: false,
    reviewerCandidatesError: null,
    prActionPending: false,
  }),
}));

vi.mock("@src/modules/shared/layouts/blocks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/modules/shared/layouts/blocks")>();
  return {
    ...actual,
    ScrollTrail: ({ testId }: { testId?: string }) =>
      createElement("nav", { "data-testid": testId }),
  };
});

vi.mock("./PrConversationTab", () => ({
  PrConversationTab: (
    props: Record<string, unknown> & {
      summary?: ReactNode;
      levelActions?: ReactNode;
    }
  ) => {
    childProps.conversation = props;
    return createElement(
      "div",
      { "data-testid": "conversation-tab" },
      props.summary,
      props.levelActions
    );
  },
}));
vi.mock("./PrChangesTab", () => ({
  PrChangesTab: (props: Record<string, unknown>) => {
    childProps.changes = props;
    return createElement("div", { "data-testid": "changes-tab" });
  },
}));
vi.mock("./PrChecksTab", () => ({
  PrChecksTab: () => createElement("div"),
}));
vi.mock("./PrCommitsTab", () => ({
  PrCommitsTab: (props: Record<string, unknown>) => {
    childProps.commits = props;
    return createElement("div", { "data-testid": "commits-tab" });
  },
}));

describe("PrDetailPanel tabs", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    childProps.changes = null;
    childProps.commits = null;
    childProps.conversation = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders GitHub-style PR navigation with icons, counts, and tab semantics", () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {},
      commits: [{}],
    });

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(PrDetailPanel, {
            identity: {
              number: 42,
              title: "Use GitHub-style navigation",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "feature/tab-pill",
              baseBranch: "main",
            },
            repoPath: "/repo",
            showHeader: false,
          })
        )
      );
    });

    const tabList = container.querySelector('[role="tablist"]');
    const tabs = Array.from(
      tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Conversation0",
      "Commits1",
      "Checks0",
      "Files changed0",
    ]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.className).toContain("rounded-t-md");
    expect(tabList?.className).toContain("border-b");
    expect(tabList?.className).not.toContain("border-t");
    const actions = container.querySelector("[data-testid='pr-level-actions']");
    expect(actions?.textContent).toContain("Enable auto-merge");
    expect(actions?.textContent).toContain("Reviewers");
    expect(actions?.textContent).toContain("Close pull request");
    expect(actions?.className).not.toContain("bg-");
    expect(actions?.className).not.toContain("border");
    expect(
      container.querySelector('[role="tabpanel"]')?.contains(actions)
    ).toBe(true);

    act(() => {
      tabs[3]?.click();
    });
    expect(store.get(workstationPrDetailTabAtomFamily(scopeKey))).toBe(
      "changes"
    );
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe(
      "pr-detail-tabpanel-changes"
    );
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-rail"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-trail"]')
    ).not.toBeNull();
  });

  it("restores the per-PR sub-tab and nested selection after remount", () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      viewState: {
        ...initialPrDetailViewState,
        activeTab: "commits",
        conversationDraft: "Keep this review draft",
        selectedCommitSha: "abc1234",
        selectedChangedFilePath: "src/index.ts",
      },
      loading: false,
      detail: {},
      commits: [{ sha: "abc1234" }],
    });
    const panel = createElement(PrDetailPanel, {
      identity: {
        number: 42,
        title: "Preserve Inbox context",
        url: "https://github.com/org/repo/pull/42",
        status: "open",
        headBranch: "feature/preserve-inbox",
        baseBranch: "main",
      },
      repoPath: "/repo",
      showHeader: false,
    });

    act(() => {
      root.render(createElement(Provider, { store }, panel));
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '#pr-detail-tab-commits[aria-selected="true"]'
      )
    ).not.toBeNull();
    expect(childProps.commits?.selectedCommitSha).toBe("abc1234");

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(createElement(Provider, { store }, panel));
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '#pr-detail-tab-commits[aria-selected="true"]'
      )
    ).not.toBeNull();
    expect(childProps.commits?.selectedCommitSha).toBe("abc1234");
    expect(
      store.get(workstationSelectedPrAtomFamily(scopeKey)).viewState
    ).toMatchObject({
      activeTab: "commits",
      conversationDraft: "Keep this review draft",
      selectedChangedFilePath: "src/index.ts",
    });
  });

  it("keeps the GitHub header at 40px and moves branch details into the Codex-style summary", () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {
        additions: 2313,
        deletions: 217,
        comments: 1,
        requested_reviewers: [
          {
            login: "reviewer",
            avatar_url: "https://example.com/reviewer.png",
          },
        ],
      },
    });

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(PrDetailPanel, {
            identity: {
              number: 42,
              title: "Use compact PR metadata",
              url: "https://github.com/org/repo/pull/42",
              status: "merged",
              headBranch: "fix/issue-556-delete-agent-org-workers",
              baseBranch: "develop",
            },
            repoPath: "/repo",
          })
        )
      );
    });

    const header = container.querySelector("[data-testid='pr-detail-header']");
    const summary = container.querySelector(
      "[data-testid='pr-detail-summary']"
    );

    expect(header?.className).toContain("h-10");
    expect(header?.className).toContain("!pl-4");
    expect(header?.className).toContain("!pr-[7px]");
    expect(header?.className).not.toContain("border-b");
    const externalLink = header?.querySelector(
      'a[aria-label="Open on GitHub"]'
    );
    expect(externalLink?.getAttribute("href")).toBe(
      "https://github.com/org/repo/pull/42"
    );
    expect(externalLink?.getAttribute("target")).toBe("_blank");
    expect(externalLink?.getAttribute("style")).toContain("height: 28px");
    expect(
      container.querySelectorAll('a[aria-label="Open on GitHub"]')
    ).toHaveLength(1);
    expect(header?.textContent).toContain("Use compact PR metadata");
    const mergedBadge = Array.from(header?.querySelectorAll("span") ?? []).find(
      (element) => element.textContent?.trim() === "merged"
    );
    expect(mergedBadge?.className).toContain("bg-purple-1");
    expect(mergedBadge?.className).toContain("text-purple-6");
    expect(header?.textContent).not.toContain("develop");
    expect(header?.textContent).not.toContain(
      "fix/issue-556-delete-agent-org-workers"
    );

    expect(summary?.textContent).toContain("Branch");
    expect(summary?.textContent).toContain(
      "fix/issue-556-delete-agent-org-workers"
    );
    expect(summary?.textContent).toContain("develop");
    expect(summary?.textContent).toContain("+2,313");
    expect(summary?.textContent).toContain("-217");
    expect(summary?.textContent).toContain("Reviewers");
    const reviewers = summary?.querySelector(
      "[data-testid='pr-summary-reviewers']"
    );
    expect(reviewers?.textContent).toContain("reviewer");
    expect(reviewers?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/reviewer.png"
    );
    expect(reviewers?.className).toContain("items-center");
    expect(summary?.textContent).toContain("Comments");
    expect(summary?.textContent).toContain("1 comment");
    expect(summary?.textContent).toContain("Checks");
    expect(summary?.textContent).toContain("No CI checks");
    expect(summary?.textContent).toContain("Status");
    expect(summary?.textContent).toContain("merged");
    const summaryStatus = Array.from(
      summary?.querySelectorAll("div") ?? []
    ).find((element) => element.textContent?.trim() === "merged");
    expect(summaryStatus?.className).toContain("text-purple-6");
    expect(summary?.className).not.toContain("border-b");
    expect(summary?.firstElementChild?.className).toContain("px-6");
    expect(summary?.firstElementChild?.className).toContain("pt-4");
    expect(summary?.firstElementChild?.className).toContain("items-center");
    expect(summary?.firstElementChild?.className).not.toContain("py-4");
  });

  it("shows the PR skeleton on the first render before detail loading starts", () => {
    const store = createStore();

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(PrDetailPanel, {
            identity: {
              number: 42,
              title: "Avoid the content-to-loading flash",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "fix/loading-flash",
              baseBranch: "main",
            },
            repoPath: "/repo",
            showHeader: false,
          })
        )
      );
    });

    expect(
      container.querySelector("[data-testid='github-pr-detail-skeleton']")
    ).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
