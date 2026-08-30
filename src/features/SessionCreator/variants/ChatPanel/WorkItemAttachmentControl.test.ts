// @vitest-environment jsdom
import { act, createElement } from "react";
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

import type { ComposerInputRef } from "@src/components/ComposerInput";

import WorkItemAttachmentControl from "./WorkItemAttachmentControl";

const dropdownMocks = vi.hoisted(() => ({
  close: vi.fn(),
  toggle: vi.fn(),
}));

const projectApiMocks = vi.hoisted(() => ({
  readWorkspaceWorkItemsData: vi.fn().mockResolvedValue({
    projectEntries: [
      {
        project: {
          slug: "project-a",
          meta: {
            id: "project-id",
            name: "Project A",
            org_id: "org-id",
          },
        },
        workItems: [
          {
            shortId: "ABC-1",
            title: "Fix local work",
            status: "in_progress",
            priority: "high",
            body: "Local work item body",
            labels: [{ name: "frontend" }],
            todos: [],
          },
        ],
      },
    ],
    standaloneWorkItems: [],
    orgs: [],
  }),
}));

const worktreeMocks = vi.hoisted(() => ({
  githubRefresh: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    close: dropdownMocks.close,
    isOpen: true,
    isPositioned: true,
    panelPosition: { left: 0, top: 0 },
    panelRef: { current: null },
    toggle: dropdownMocks.toggle,
    triggerRef: { current: null },
  }),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: projectApiMocks,
}));

vi.mock(
  "@src/features/SessionCreator/components/useWorktreeSourceData",
  () => ({
    useWorktreeSourceData: () => ({
      github: {
        prs: [
          {
            number: 43,
            title: "Draft account fix",
            state: "open",
            url: "https://github.com/acme/app/pull/43",
            head_branch: "fix/account",
            base_branch: "main",
            draft: true,
            ci_status: "failure",
            author_login: "octocat",
          },
          {
            number: 44,
            title: "Running checks",
            state: "open",
            url: "https://github.com/acme/app/pull/44",
            head_branch: "checks/running",
            base_branch: "main",
            draft: false,
            ci_status: "pending",
            author_login: "check-author",
          },
          {
            number: 45,
            title: "Loading checks",
            state: "open",
            url: "https://github.com/acme/app/pull/45",
            head_branch: "checks/loading",
            base_branch: "main",
            draft: false,
            ci_status: "unavailable",
            author_login: "load-author",
          },
        ],
        issues: [
          {
            number: 42,
            title: "Fix login bug",
            state: "open",
            html_url: "https://github.com/acme/app/issues/42",
            labels: [{ name: "bug" }],
            user: {
              login: "issue-author",
              avatar_url: "https://example.com/issue-author.png",
            },
          },
        ],
        repoFullName: "acme/app",
        state: "ready",
        error: null,
        refreshing: false,
        refresh: worktreeMocks.githubRefresh,
      },
      branch: {
        options: [],
        state: "idle",
        error: null,
        refreshing: false,
        refresh: vi.fn(),
      },
    }),
  })
);

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.trim() === text);
}

describe("WorkItemAttachmentControl", () => {
  let container: HTMLDivElement;
  let pickerPortalTarget: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    dropdownMocks.close.mockClear();
    dropdownMocks.toggle.mockClear();
    projectApiMocks.readWorkspaceWorkItemsData.mockClear();
    worktreeMocks.githubRefresh.mockClear();
    container = document.createElement("div");
    pickerPortalTarget = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(pickerPortalTarget);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    pickerPortalTarget.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("navigates directly to the Work Item creator outside solve mode", () => {
    const onCreateWorkItem = vi.fn();
    act(() => {
      root.render(
        createElement(WorkItemAttachmentControl, { onCreateWorkItem })
      );
    });

    const trigger = container.querySelector(
      '[data-testid="session-creator-work-item-toggle"]'
    );
    expect(trigger?.getAttribute("aria-haspopup")).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreateWorkItem).toHaveBeenCalledOnce();
    expect(projectApiMocks.readWorkspaceWorkItemsData).not.toHaveBeenCalled();
  });

  it("replaces the Launchpad card with an attached chrome picker and Back restores it", async () => {
    const onPickerOpenChange = vi.fn();
    act(() => {
      root.render(
        createElement(WorkItemAttachmentControl, {
          mode: "solve",
          onPickerOpenChange,
          pickerPortalTarget,
          presentation: "card",
        })
      );
    });

    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-panel-start-page-solve-work-item"]'
    );
    expect(card).not.toBeNull();
    expect(card?.className).toContain("flex-col");
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      card?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onPickerOpenChange).toHaveBeenLastCalledWith(true);
    const picker = pickerPortalTarget.querySelector(
      '[data-testid="work-item-picker-panel"]'
    );
    expect(picker).not.toBeNull();
    expect(picker?.parentElement).toBe(pickerPortalTarget);
    expect(
      container.querySelector(
        '[data-testid="session-creator-work-item-inline-picker"]'
      )
    ).toBeNull();
    expect(
      pickerPortalTarget.querySelector('[data-testid="work-item-picker-list"]')
        ?.className
    ).not.toContain("max-h-64");
    expect(
      pickerPortalTarget.querySelector('[data-testid="work-item-picker-list"]')
        ?.className
    ).toContain("overscroll-contain");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="work-item-picker-option-workitem:project-a/ABC-1"]'
      )?.className
    ).toContain("work-item-picker-option");
    expect(
      pickerPortalTarget.querySelector('[data-testid="work-item-picker-list"]')
        ?.className
    ).toContain("gap-px");
    const allFilter = pickerPortalTarget.querySelector(
      '[data-testid="work-item-picker-filter-all"]'
    );
    expect(allFilter?.className).toContain("text-[12px]");
    expect(allFilter?.parentElement?.className).toContain("flex-nowrap");
    expect(allFilter?.parentElement?.className).toContain(
      "@container/workitemtabs"
    );
    expect(allFilter?.getAttribute("aria-label")).toBe("common:actions.all");
    expect(allFilter?.querySelector("span:last-child")?.className).toContain(
      "hidden"
    );
    expect(allFilter?.querySelector("span:last-child")?.className).toContain(
      "@[500px]/workitemtabs:inline"
    );
    expect(allFilter?.className).toContain("after:bg-chat-pane");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="work-item-picker-kind-github_pr:https://github.com/acme/app/pull/43"]'
      )?.className
    ).toContain("text-text-2");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/43"]'
      )?.className
    ).toContain("text-danger-6");
    expect(
      pickerPortalTarget
        .querySelector(
          '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/43"]'
        )
        ?.querySelector("svg")
        ?.getAttribute("data-icon") === "x"
    ).toBe(true);
    expect(picker?.textContent).toContain("@octocat");
    expect(picker?.textContent).toContain("@issue-author");
    const prMetadataText = pickerPortalTarget.querySelector(
      '[data-testid="work-item-picker-option-github_pr:https://github.com/acme/app/pull/43"] .work-item-picker-option-metadata'
    )?.textContent;
    expect(prMetadataText?.indexOf("@octocat") ?? -1).toBeLessThan(
      prMetadataText?.indexOf("draft") ?? -1
    );
    expect(
      pickerPortalTarget
        .querySelector(
          '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/44"]'
        )
        ?.querySelector("span")
        ?.classList.contains("animate-pulse")
    ).toBe(true);
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/45"]'
      )
    ).toBeNull();
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="session-creator-work-item-picker-back"]'
      )?.parentElement?.className
    ).not.toContain("border-b");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="session-creator-work-item-picker-back"]'
      )?.textContent
    ).toBe("");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="session-creator-work-item-picker-back"]'
      )?.className
    ).toContain("border-border-2");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="session-creator-work-item-picker-refresh"]'
      )?.className
    ).toContain("border-border-2");
    expect(
      pickerPortalTarget.querySelector(
        '[data-testid="session-creator-work-item-picker-refresh"]'
      )?.parentElement
    ).toBe(
      pickerPortalTarget.querySelector(
        '[data-testid="session-creator-work-item-picker-back"]'
      )?.parentElement
    );
    expect(
      container.querySelector(
        '[data-testid="chat-panel-start-page-solve-work-item"]'
      )
    ).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      pickerPortalTarget
        .querySelector<HTMLButtonElement>(
          '[data-testid="session-creator-work-item-picker-refresh"]'
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledTimes(2);
    expect(worktreeMocks.githubRefresh).toHaveBeenCalledOnce();

    act(() => {
      pickerPortalTarget
        .querySelector<HTMLButtonElement>(
          '[data-testid="session-creator-work-item-picker-back"]'
        )
        ?.click();
    });

    expect(onPickerOpenChange).toHaveBeenLastCalledWith(false);
    expect(
      container.querySelector(
        '[data-testid="chat-panel-start-page-solve-work-item"]'
      )
    ).not.toBeNull();
  });

  it("loads lazily, filters sources, and inserts selected items as composer pills", async () => {
    const insertFilePill = vi.fn();
    const focus = vi.fn();
    const onWorkItemContextChange = vi.fn();
    const composerInputRef = {
      current: {
        focus,
        getFilePills: vi.fn(() => []),
        insertFilePill,
      } as unknown as ComposerInputRef,
    };
    act(() => {
      root.render(
        createElement(WorkItemAttachmentControl, {
          composerInputRef,
          mode: "solve",
          onWorkItemContextChange,
          repoId: "repo-id",
          repoPath: "/repo",
        })
      );
    });

    expect(projectApiMocks.readWorkspaceWorkItemsData).not.toHaveBeenCalled();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-creator-work-item-toggle"]'
    );

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledOnce();
    expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledWith({
      readBucket: "active",
    });
    expect(
      document.querySelector('[data-testid="work-item-picker-panel"]')
    ).not.toBeNull();

    const localOption = document.querySelector(
      '[data-testid="work-item-picker-option-workitem:project-a/ABC-1"]'
    );
    expect(localOption).not.toBeNull();
    act(() => {
      localOption
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click();
    });

    const issueFilter = document.querySelector<HTMLButtonElement>(
      '[data-testid="work-item-picker-filter-github_issue"]'
    );
    act(() => issueFilter?.click());
    expect(
      document.querySelector(
        '[data-testid="work-item-picker-option-workitem:project-a/ABC-1"]'
      )
    ).toBeNull();

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]'
    );
    act(() => {
      if (!search) return;
      search.value = "login";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const githubOption = document.querySelector(
      '[data-testid="work-item-picker-option-github_issue:https://github.com/acme/app/issues/42"]'
    );
    expect(githubOption).not.toBeNull();
    act(() => {
      githubOption
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click();
    });

    await act(async () => {
      findButton("common:actions.add")?.click();
      await Promise.resolve();
    });

    expect(insertFilePill).toHaveBeenCalledTimes(2);
    expect(insertFilePill).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^workitem:\/\/project-a\/ABC-1\/\d+$/),
      false,
      "workitem",
      "ABC-1 Fix local work"
    );
    expect(insertFilePill).toHaveBeenNthCalledWith(
      2,
      "https://github.com/acme/app/issues/42",
      false,
      "issue",
      "#42 Fix login bug"
    );
    const workItemPillPath = insertFilePill.mock.calls[0]?.[0] as string;
    expect(window.__orgiiTerminalPillTexts?.[workItemPillPath]).toContain(
      "Local work item body"
    );
    expect(onWorkItemContextChange).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: "project-a",
        workItemId: "ABC-1",
      })
    );
    expect(focus).toHaveBeenCalledOnce();

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledTimes(2);
  });

  it("retains the link-existing menu outside Launchpad", async () => {
    act(() => {
      root.render(createElement(WorkItemAttachmentControl));
    });

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.body.textContent).toContain("common:actions.link");

    const linkAction = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((element) => element.textContent?.includes("common:actions.link"));

    await act(async () => {
      linkAction?.click();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="work-item-picker-panel"]')
    ).not.toBeNull();
  });
});
