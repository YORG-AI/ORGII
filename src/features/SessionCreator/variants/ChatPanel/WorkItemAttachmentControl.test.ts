// @vitest-environment jsdom
import { act, createElement, useCallback, useRef, useState } from "react";
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
  useDropdownEngine: () => {
    const [isOpen, setOpen] = useState(false);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);
    const close = useCallback(() => {
      dropdownMocks.close();
      setOpen(false);
    }, []);
    const toggle = useCallback(() => {
      dropdownMocks.toggle();
      setOpen((value) => !value);
    }, []);
    return {
      close,
      isOpen,
      toggle,
      triggerRef,
      panelRef,
      isPositioned: true,
      panelPosition: { left: 0, top: 0 },
    };
  },
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
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    dropdownMocks.close.mockClear();
    dropdownMocks.toggle.mockClear();
    projectApiMocks.readWorkspaceWorkItemsData.mockClear();
    worktreeMocks.githubRefresh.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
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

  it.each(["card", "pill"] as const)(
    "opens a modal from the %s without replacing the trigger and restores focus on Escape",
    async (presentation) => {
      act(() =>
        root.render(
          createElement(WorkItemAttachmentControl, {
            mode: "solve",
            presentation,
          })
        )
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-panel-start-page-solve-work-item"]'
      );
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
      expect(projectApiMocks.readWorkspaceWorkItemsData).not.toHaveBeenCalled();
      await act(async () => {
        trigger?.click();
      });
      act(() => vi.advanceTimersByTime(100));

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      expect(dialog?.getAttribute("aria-label")).toBe(
        "sessions:creator.solveWorkItem"
      );
      expect(container.contains(dialog)).toBe(false);
      expect(
        container.querySelector(
          '[data-testid="chat-panel-start-page-solve-work-item"]'
        )
      ).toBe(trigger);
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(
        dialog?.querySelector('input[type="text"]')
      );
      expect(findButton("common:actions.add")?.disabled).toBe(true);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(dialog?.textContent).toContain("@octocat");
      expect(dialog?.textContent).toContain("@issue-author");
      const prMetadataText = dialog?.querySelector(
        '[data-testid="work-item-picker-option-github_pr:https://github.com/acme/app/pull/43"] .work-item-picker-option-metadata'
      )?.textContent;
      expect(prMetadataText?.indexOf("@octocat") ?? -1).toBeLessThan(
        prMetadataText?.indexOf("draft") ?? -1
      );
      expect(
        dialog?.querySelector(
          '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/43"]'
        )?.className
      ).toContain("text-danger-6");
      expect(
        dialog
          ?.querySelector(
            '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/44"] span'
          )
          ?.classList.contains("animate-pulse")
      ).toBe(true);
      expect(
        dialog?.querySelector(
          '[data-testid="work-item-picker-ci-github_pr:https://github.com/acme/app/pull/45"]'
        )
      ).toBeNull();

      await act(async () => {
        dialog
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="session-creator-work-item-picker-refresh"]'
          )
          ?.click();
      });
      expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledTimes(
        2
      );
      expect(worktreeMocks.githubRefresh).toHaveBeenCalledOnce();
      act(() =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        )
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
    }
  );

  it("loads lazily, filters sources, and inserts selected items as composer pills", async () => {
    const insertFilePill = vi.fn();
    const editorInput = document.createElement("textarea");
    const focus = vi.fn(() => editorInput.focus());
    const getFilePills = vi.fn((): Array<{ filePath: string }> => []);
    const onWorkItemContextChange = vi.fn();
    const composerInputRef = {
      current: {
        focus,
        getFilePills,
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

    container.appendChild(editorInput);
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

    const search =
      document.querySelector<HTMLInputElement>('input[type="text"]');
    act(() => {
      expect(search).not.toBeNull();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(search, "login");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
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
    expect(document.activeElement).toBe(editorInput);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    getFilePills.mockReturnValue(
      insertFilePill.mock.calls.map(([filePath]) => ({ filePath }))
    );

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector<HTMLInputElement>('input[type="text"]')?.value
    ).toBe("");
    expect(
      document
        .querySelector('[data-testid="work-item-picker-filter-all"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    for (const key of [
      "workitem:project-a/ABC-1",
      "github_issue:https://github.com/acme/app/issues/42",
    ]) {
      const checkbox = document.querySelector<HTMLInputElement>(
        `[data-testid="work-item-picker-option-${key}"] input[type="checkbox"]`
      );
      expect(checkbox?.checked).toBe(false);
      act(() => checkbox?.click());
    }
    await act(async () => findButton("common:actions.add")?.click());
    expect(insertFilePill).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(editorInput);
  });

  it("retains the link-existing menu outside Launchpad", async () => {
    act(() => {
      root.render(createElement(WorkItemAttachmentControl));
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="session-creator-work-item-toggle"]'
        )
        ?.click()
    );
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.body.textContent).toContain("common:actions.link");

    const linkAction = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((element) => element.textContent?.includes("common:actions.link"));

    await act(async () => {
      linkAction?.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="work-item-picker-panel"]')
    ).not.toBeNull();
    act(() => findButton("common:actions.cancel")?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector(
        '[data-testid="session-creator-work-item-toggle"]'
      )
    );
  });
});
