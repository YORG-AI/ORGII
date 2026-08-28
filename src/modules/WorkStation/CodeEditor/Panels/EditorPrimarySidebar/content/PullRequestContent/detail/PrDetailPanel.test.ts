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

/** Measured body width driving the rail's column-vs-stacked placement. */
const bodyWidth = vi.hoisted(() => ({ value: 0 }));

vi.mock("@src/hooks/ui/layout/useElementDimensions", () => ({
  useElementDimensions: () => bodyWidth.value,
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
    updateAssignees: vi.fn(),
    updateLabels: vi.fn(),
    loadReviewerCandidates: vi.fn().mockResolvedValue(undefined),
    reviewerCandidates: [],
    assigneeCandidates: [],
    loadingReviewerCandidates: false,
    reviewerCandidatesError: null,
    loadLabelCandidates: vi.fn().mockResolvedValue(undefined),
    labelCandidates: [],
    loadingLabelCandidates: false,
    labelCandidatesError: null,
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
      flowHeader?: ReactNode;
      sidebar?: ReactNode;
    }
  ) => {
    childProps.conversation = props;
    return createElement(
      "div",
      { "data-testid": "conversation-tab" },
      props.flowHeader,
      props.sidebar
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
    // 0 = unmeasured, which keeps the rail as its own column.
    bodyWidth.value = 0;
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
    // Details rail: always shown, rendered at the panel level (beside the tab
    // panels, not inside them), with the scroll trail sharing its column.
    const rail = container.querySelector(
      "[data-testid='pr-detail-sidebar-rail']"
    );
    expect(rail).not.toBeNull();
    const sidebar = container.querySelector("[data-testid='pr-sidebar']");
    expect(rail?.contains(sidebar)).toBe(true);
    const navigationRail = container.querySelector(
      '[data-testid="pr-detail-navigation-rail"]'
    );
    expect(rail?.contains(navigationRail as Node)).toBe(true);
    expect(sidebar?.compareDocumentPosition(navigationRail as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // The rail opens straight into its sections — no panel title above them.
    expect(sidebar?.textContent).not.toContain("Details");
    expect(sidebar?.textContent).toContain("Reviewers");
    expect(sidebar?.textContent).toContain("Assignees");
    expect(sidebar?.textContent).toContain("No one assigned");
    expect(sidebar?.textContent).toContain("Labels");
    expect(sidebar?.textContent).toContain("None yet");
    expect(
      sidebar?.querySelector('[data-testid="pr-reviewer-action"]')
    ).not.toBeNull();
    // The rail is permanent: no show/hide affordance remains.
    expect(
      sidebar?.querySelector('[data-testid="pr-sidebar-collapse"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="pr-sidebar-toggle"]')
    ).toBeNull();
    const actions = container.querySelector("[data-testid='pr-level-actions']");
    expect(sidebar?.contains(actions)).toBe(true);
    expect(actions?.className).toContain("flex-col");
    expect(actions?.textContent).toContain("Enable auto-merge");
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
        '[data-testid="pr-state-action"]'
      )?.style.height
    ).toBe("28px");
    expect(actions?.className).not.toContain("bg-");
    expect(actions?.className).not.toContain("border");
    expect(
      container.querySelector('[role="tabpanel"]')?.contains(actions)
    ).toBe(false);
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
      expect(conversationPanel?.style.display).toBe("none");
      // The details rail stays for every tab; the conversation scroll trail
      // belongs to the conversation and steps aside with it.
      expect(
        container.querySelector('[data-testid="pr-detail-sidebar-rail"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="pr-detail-navigation-rail"]')
      ).toBeNull();
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
      container.querySelector<HTMLElement>("#pr-detail-tabpanel-conversation")
        ?.style.display
    ).toBe("none");
    // Files changed keeps the rail too — it is no longer hideable — while the
    // conversation-owned scroll trail steps aside with its tab.
    expect(
      container.querySelector('[data-testid="pr-detail-sidebar-rail"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-rail"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="pr-detail-navigation-trail"]')
    ).toBeNull();
  });

  it("stacks the details rail under the flow title when the body is narrow", () => {
    bodyWidth.value = 640;
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {},
    });

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(PrDetailPanel, {
            identity: {
              number: 42,
              title: "Stack the rail when space runs out",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "feature/narrow",
              baseBranch: "main",
            },
            repoPath: "/repo",
            showHeader: false,
          })
        )
      );
    });

    // No second column: the rail is handed to the conversation, which renders
    // it under the flow title and above the description.
    expect(
      container.querySelector('[data-testid="pr-detail-sidebar-rail"]')
    ).toBeNull();
    expect(childProps.conversation?.sidebar).toBeTruthy();
    const conversationTab = container.querySelector(
      '[data-testid="conversation-tab"]'
    );
    const flowHeader = conversationTab?.querySelector(
      '[data-testid="pr-flow-header"]'
    );
    const stackedSidebar = conversationTab?.querySelector(
      '[data-testid="pr-sidebar"]'
    );
    expect(stackedSidebar).not.toBeNull();
    expect(flowHeader?.compareDocumentPosition(stackedSidebar as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // The trail keeps its own narrow column while the rail is stacked.
    const navigationRail = container.querySelector(
      '[data-testid="pr-detail-navigation-rail"]'
    );
    expect(navigationRail).not.toBeNull();
    expect(navigationRail?.className).toContain("shrink-0");
  });

  it("stacks a combined PR header below the detail-panel breakpoint without a separator", () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {},
    });

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(PrDetailPanel, {
            identity: {
              number: 42,
              title: "Use a responsive PR header",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "feature/responsive-header",
              baseBranch: "main",
            },
            repoPath: "/repo",
            combineHeaderAndTabs: true,
          })
        )
      );
    });

    const panel = container.firstElementChild;
    const header = container.querySelector<HTMLElement>(
      "[data-testid='pr-detail-header']"
    );
    const title = header?.querySelector<HTMLElement>(
      "[data-testid='detail-header-title']"
    );

    expect(panel?.className).toContain("@container/detailheader");
    expect(header?.className).toContain("!h-auto");
    expect(header?.className).toContain("border-b");
    expect(title?.parentElement?.className).toContain("flex-col");
    expect(title?.parentElement?.className).toContain(
      "@[960px]/detailheader:flex-row"
    );
    expect(header?.querySelector('[role="separator"]')).toBeNull();
    expect(header?.querySelectorAll('[role="tab"]')).toHaveLength(4);
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
    expect(
      conflictAction?.querySelector('[data-icon="xcircle"]')
    ).not.toBeNull();
    expect(
      conflictAction?.parentElement?.querySelector('[data-icon="chevron-down"]')
    ).not.toBeNull();
  });

  it("uses a neutral fill for drafts and keeps their rail editors", async () => {
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
      draftAction?.querySelector('[data-icon="git-pull-request-draft"]')
    ).not.toBeNull();
    await act(async () => {
      draftAction?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      document.body.querySelector('[data-testid="pr-mark-ready-action"]')
    ).not.toBeNull();
    // A draft is still an open pull request, so its rail keeps every editor.
    expect(
      container.querySelector('[data-testid="pr-reviewer-action"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-assignee-action"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pr-label-action"]')
    ).not.toBeNull();
  });

  it("offers converting an open pull request to draft as its own button", async () => {
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

    const actions = container.querySelector('[data-testid="pr-level-actions"]');
    const convertAction = actions?.querySelector(
      '[data-testid="pr-convert-to-draft-action"]'
    );
    expect(convertAction?.textContent).toContain("Convert to draft");
    expect(
      convertAction?.querySelector('[data-icon="git-pull-request-draft"]')
    ).not.toBeNull();

    // The action moved out of the merge dropdown into the actions stack.
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
    expect(
      document.body.querySelectorAll(
        '[data-testid="pr-convert-to-draft-action"]'
      )
    ).toHaveLength(1);
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

  it("keeps the GitHub header at 40px and renders the GitHub-flow title and operations sidebar", () => {
    const store = createStore();
    const scopeKey = workstationPrScopeKey(undefined, "/repo", 42);
    store.set(workstationSelectedPrAtomFamily(scopeKey), {
      ...initialSelectedPrState,
      loading: false,
      detail: {
        additions: 2313,
        deletions: 217,
        comments: 1,
        commits: 3,
        merged: true,
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
        labels: [{ name: "bug", color: "d73a4a" }],
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
    const flowHeader = container.querySelector(
      "[data-testid='pr-flow-header']"
    );
    const sidebar = container.querySelector("[data-testid='pr-sidebar']");

    expect(header?.className).toContain("h-10");
    expect(header?.className).toContain("!pl-4");
    expect(header?.className).toContain("!pr-[7px]");
    expect(header?.className).not.toContain("border-b");
    const externalLink = header?.querySelector(
      'button[aria-label="Open in external browser"]'
    );
    expect(externalLink?.getAttribute("type")).toBe("button");
    expect(externalLink?.getAttribute("style")).toContain("height: 28px");
    expect(externalLink?.querySelector('[data-icon="chrome"]')).not.toBeNull();
    expect(
      container.querySelectorAll(
        'button[aria-label="Open in external browser"]'
      )
    ).toHaveLength(1);
    expect(header?.textContent).toContain("Use compact PR metadata");
    const mergedStatus = header?.querySelector(
      "[data-testid='pr-detail-status']"
    );
    expect(mergedStatus?.className).toContain("text-purple-6");
    expect(mergedStatus?.className).not.toContain("bg-purple-1");
    expect(mergedStatus?.className).not.toContain("rounded-full");
    expect(
      mergedStatus?.querySelector('[data-icon="git-merge"]')
    ).not.toBeNull();
    expect(mergedStatus?.textContent).toBe("");
    expect(header?.textContent).not.toContain("develop");
    expect(header?.textContent).not.toContain(
      "fix/issue-556-delete-agent-org-workers"
    );

    // GitHub-flow title: big title + muted #number over a status pill and
    // the merge-flow sentence with branch pills and the diff stat.
    const flowTitle = flowHeader?.querySelector(
      "[data-testid='pr-flow-title']"
    );
    expect(flowTitle?.textContent).toContain("Use compact PR metadata");
    expect(flowTitle?.textContent).toContain("#42");
    const flowStatus = flowHeader?.querySelector(
      "[data-testid='pr-flow-status']"
    );
    expect(flowStatus?.textContent).toContain("merged");
    expect(flowStatus?.querySelector('[data-icon="git-merge"]')).not.toBeNull();
    expect(flowStatus?.firstElementChild?.className).toContain("bg-purple-1");
    expect(flowStatus?.firstElementChild?.className).toContain("text-purple-6");
    const subline = flowHeader?.querySelector(
      "[data-testid='pr-flow-subline']"
    );
    expect(subline?.textContent).toContain("creator");
    expect(subline?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/creator.png"
    );
    expect(subline?.textContent).toContain("merged 3 commits into");
    expect(subline?.textContent).not.toContain("wants to merge");
    expect(subline?.textContent).toContain("develop");
    expect(subline?.textContent).toContain(
      "fix/issue-556-delete-agent-org-workers"
    );
    expect(subline?.textContent).toContain("+2,313");
    expect(subline?.textContent).toContain("-217");
    expect(
      subline?.querySelector("[data-testid='pr-flow-copy-branch']")
    ).not.toBeNull();

    // Operations sidebar: requested reviewer listed, no reviewer picker on a
    // merged PR, and the read-only label chip.
    const reviewersSection = sidebar?.querySelector(
      "[data-testid='pr-sidebar-reviewers']"
    );
    expect(reviewersSection?.textContent).toContain("reviewer");
    expect(reviewersSection?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/reviewer.png"
    );
    expect(
      sidebar?.querySelector("[data-testid='pr-reviewer-action']")
    ).toBeNull();
    expect(
      sidebar?.querySelector("[data-testid='pr-sidebar-assignees']")
        ?.textContent
    ).toContain("No one assigned");
    expect(
      sidebar?.querySelector("[data-testid='pr-sidebar-labels']")?.textContent
    ).toContain("bug");
    expect(
      sidebar?.querySelector("[data-testid='pr-level-actions']")
    ).not.toBeNull();
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
