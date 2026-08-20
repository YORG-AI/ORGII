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
import { formatPrFilesCount } from "./prFilesDisplay";

const childProps = vi.hoisted(() => ({
  changes: null as Record<string, unknown> | null,
  commits: null as Record<string, unknown> | null,
  conversation: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (key === "git.pr.actions.resolveConflicts") {
        return "Localized conflict label";
      }
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
    updatePullRequestDraft: vi.fn(),
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

  it("marks the GitHub PR-files ceiling as a lower bound", () => {
    expect(formatPrFilesCount(2999)).toBe(2999);
    expect(formatPrFilesCount(3000)).toBe("3000+");
    expect(formatPrFilesCount(3200)).toBe("3000+");
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
    expect(tabs[0]?.className).toContain("text-text-1");
    for (const tab of tabs.slice(1)) {
      expect(tab.className).toContain("text-text-2");
      expect(tab.className).not.toContain("text-text-3");
    }
    expect(tabList?.className).toContain("border-b");
    expect(tabList?.className).not.toContain("border-t");
    expect(tabList?.className).toContain("gap-px");
    expect(tabList?.className).not.toContain("h-10");
    expect(tabs[0]?.className).toContain("after:-bottom-px");
    expect(tabs[0]?.className).toContain("after:bg-bg-2");
    for (const tab of tabs) {
      expect(tab.className).toContain("py-1.5");
      expect(tab.className).not.toContain("h-9");
    }
    const actions = container.querySelector("[data-testid='pr-level-actions']");
    expect(actions?.textContent).toContain("Enable auto-merge");
    expect(actions?.textContent).toContain("Reviewers");
    expect(actions?.textContent).toContain("Close");
    expect(actions?.textContent).not.toContain("Close pull request");
    const closeAction = actions?.querySelector<HTMLButtonElement>(
      '[data-testid="pr-state-action"]'
    );
    expect(closeAction?.className).toContain("text-text-1");
    expect(closeAction?.className).not.toContain("text-danger-6");
    expect(
      actions?.querySelector<HTMLButtonElement>(
        '[data-testid="pr-merge-action"]'
      )?.style.height
    ).toBe("28px");
    expect(
      actions?.querySelector<HTMLButtonElement>(
        '[data-testid="pr-reviewer-action"]'
      )?.style.height
    ).toBe("28px");
    expect(
      actions?.querySelector<HTMLButtonElement>(
        '[data-testid="pr-state-action"]'
      )?.style.height
    ).toBe("28px");
    expect(actions?.className).not.toContain("bg-");
    expect(actions?.className).not.toContain("border");
    expect(
      container.querySelector('[role="tabpanel"]')?.contains(actions)
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-rail"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-trail"]')
    ).not.toBeNull();

    for (const tabIndex of [1, 2, 3]) {
      act(() => {
        tabs[tabIndex]?.click();
      });
      const activePanel = container.querySelector<HTMLElement>(
        '[role="tabpanel"][aria-hidden="false"]'
      );
      const conversationPanel = container.querySelector<HTMLElement>(
        "#pr-detail-tabpanel-conversation"
      );
      expect(activePanel?.id).toBe(
        `pr-detail-tabpanel-${["commits", "checks", "changes"][tabIndex - 1]}`
      );
      expect(
        container.querySelector('[data-testid="pr-detail-navigation-rail"]')
      ).not.toBeNull();
      expect(conversationPanel?.style.display).toBe("none");
    }

    act(() => {
      tabs[0]?.click();
    });
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-rail"]')
    ).not.toBeNull();

    act(() => {
      tabs[3]?.click();
    });
    expect(store.get(workstationPrDetailTabAtomFamily(scopeKey))).toBe(
      "changes"
    );
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelector('[role="tabpanel"][aria-hidden="false"]')?.id
    ).toBe("pr-detail-tabpanel-changes");
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-rail"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-trail"]')
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>("#pr-detail-tabpanel-conversation")
        ?.style.display
    ).toBe("none");
  });

  it("keeps conflict styling while exposing the open-PR action dropdown", () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "clean",
        merge_state_status: "DIRTY",
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
              title: "Expose merge conflicts",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "feature/conflicts",
              baseBranch: "main",
            },
            repoPath: "/repo",
            showHeader: false,
          })
        )
      );
    });

    const conflictAction = container.querySelector<HTMLButtonElement>(
      '[data-testid="pr-merge-action"]'
    );
    expect(conflictAction?.textContent).toBe("Merge conflicts");
    expect(conflictAction?.disabled).toBe(false);
    expect(conflictAction?.className).toContain("text-danger-6");
    expect(conflictAction?.querySelector(".lucide-circle-x")).not.toBeNull();
    expect(
      conflictAction?.parentElement?.querySelector(".lucide-chevron-down")
    ).not.toBeNull();
  });

  it("uses a neutral fill for drafts and omits unavailable reviewer controls", async () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {
        state: "open",
        draft: true,
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
              title: "Keep draft actions neutral",
              url: "https://github.com/org/repo/pull/42",
              status: "draft",
              headBranch: "feature/draft",
              baseBranch: "main",
            },
            repoPath: "/repo",
            showHeader: false,
          })
        )
      );
    });

    const draftAction = container.querySelector<HTMLButtonElement>(
      '[data-testid="pr-merge-action"]'
    );
    expect(draftAction?.textContent).toBe("Draft");
    expect(draftAction?.disabled).toBe(false);
    expect(draftAction?.className).toContain("!bg-fill-3");
    expect(draftAction?.className).toContain("!text-text-1");
    expect(draftAction?.className).not.toContain("bg-success-6");
    expect(
      draftAction?.querySelector(".lucide-git-pull-request-draft")
    ).not.toBeNull();
    await act(async () => {
      draftAction?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      document.body.querySelector('[data-testid="pr-mark-ready-action"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-reviewer-action"]')
    ).toBeNull();
  });

  it("offers converting an open pull request to draft from the action dropdown", async () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {
        state: "open",
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
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
              title: "Allow converting to draft",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "feature/ready",
              baseBranch: "main",
            },
            repoPath: "/repo",
            showHeader: false,
          })
        )
      );
    });

    const mergeAction = container.querySelector<HTMLButtonElement>(
      '[data-testid="pr-merge-action"]'
    );
    const dropdownButton = mergeAction?.parentElement?.querySelectorAll(
      "button"
    )[1] as HTMLButtonElement | undefined;
    await act(async () => {
      dropdownButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const convertAction = document.body.querySelector(
      '[data-testid="pr-convert-to-draft-action"]'
    );
    expect(convertAction?.textContent).toContain("Convert to draft");
    expect(
      convertAction?.querySelector(".lucide-git-pull-request-draft")
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
        user: {
          login: "creator",
          avatar_url: "https://example.com/creator.png",
        },
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
    expect(externalLink?.querySelector(".lucide-globe")).not.toBeNull();
    expect(
      container.querySelectorAll('a[aria-label="Open on GitHub"]')
    ).toHaveLength(1);
    expect(header?.textContent).toContain("Use compact PR metadata");
    const mergedStatus = header?.querySelector(
      "[data-testid='pr-detail-status']"
    );
    expect(mergedStatus?.className).toContain("text-purple-6");
    expect(mergedStatus?.className).not.toContain("bg-purple-1");
    expect(mergedStatus?.className).not.toContain("rounded-full");
    expect(mergedStatus?.querySelector(".lucide-git-merge")).not.toBeNull();
    expect(mergedStatus?.textContent).toBe("");
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
    expect(summary?.textContent).toContain("Created by");
    const author = summary?.querySelector("[data-testid='pr-summary-author']");
    expect(author?.textContent).toContain("creator");
    expect(author?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/creator.png"
    );
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
    const summaryStatus = summary?.querySelector(
      "[data-testid='pr-summary-status']"
    );
    expect(summaryStatus?.className).toContain("text-purple-6");
    expect(summaryStatus?.className).not.toContain("rounded-full");
    expect(summaryStatus?.className).not.toContain("bg-purple-1");
    expect(summaryStatus?.textContent).toBe("merged");
    expect(summaryStatus?.querySelector(".lucide-git-merge")).not.toBeNull();
    const summaryStatusLabel = summary?.querySelector(
      "[data-testid='pr-summary-status-label']"
    );
    expect(summaryStatusLabel?.className).toContain("text-text-3");
    expect(
      summaryStatusLabel?.querySelector(".lucide-circle-dot")
    ).not.toBeNull();
    expect(
      summaryStatusLabel?.querySelector(".lucide-circle-dot")?.className
    ).not.toContain("text-purple-6");
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
