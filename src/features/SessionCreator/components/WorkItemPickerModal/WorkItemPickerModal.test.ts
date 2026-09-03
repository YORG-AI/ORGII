// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceWorkItemsData } from "@src/api/http/project";
import { installVirtualListTestLayout } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/__tests__/virtualListTestLayout";

import WorkItemPickerModal, { type WorkItemPickerModalProps } from "./index";

const mocks = vi.hoisted(() => ({
  readWorkspaceWorkItemsData: vi.fn(),
  useWorktreeSourceData: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/api/http/project", () => ({ projectApi: mocks }));
vi.mock("../useWorktreeSourceData", () => ({
  useWorktreeSourceData: mocks.useWorktreeSourceData,
}));

function snapshot(title = "Local work"): WorkspaceWorkItemsData {
  return {
    projectEntries: [
      {
        project: {
          slug: "project",
          meta: { id: "project-id", name: "Project", org_id: "org" },
        },
        workItems: [
          {
            shortId: "ABC-1",
            title,
            status: "planned",
            priority: "medium",
            body: "Work item body",
            labels: [],
            todos: [],
          },
        ],
      },
    ],
    standaloneWorkItems: [],
    orgs: [],
  } as unknown as WorkspaceWorkItemsData;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function addAction() {
  const result = document.querySelector<HTMLElement>(
    '[data-testid="work-item-picker-add"]'
  );
  expect(result).not.toBeNull();
  return result!;
}

function filter(label: string) {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="work-item-picker-tabs"] button'
    )
  ).find((element) => element.textContent === label);
  expect(result).toBeDefined();
  return result!;
}

function key(target: EventTarget, key: string, shiftKey = false) {
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      })
    )
  );
}

function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectLocal() {
  const checkbox = document.querySelector<HTMLInputElement>(
    '[data-testid="work-item-picker-option-workitem:project/ABC-1"] input[type="checkbox"]'
  );
  expect(checkbox).not.toBeNull();
  act(() => checkbox!.click());
}

describe("WorkItemPickerModal", () => {
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let root: Root;
  let props: WorkItemPickerModalProps;
  let restoreLayout: () => void;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const render = async (changes: Partial<WorkItemPickerModalProps> = {}) => {
    props = { ...props, ...changes };
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(WorkItemPickerModal, props)
        )
      )
    );
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    restoreLayout = installVirtualListTestLayout();
    vi.clearAllMocks();
    mocks.readWorkspaceWorkItemsData.mockReset().mockResolvedValue(snapshot());
    mocks.useWorktreeSourceData.mockImplementation(
      ({ repoId }: { repoId?: string }) => ({
        github: {
          prs: [],
          issues: [
            {
              number: 42,
              title: `Issue from ${repoId}`,
              state: "open",
              html_url: `https://github.com/acme/${repoId}/issues/42`,
              labels: [],
              user: { login: "author", avatar_url: "" },
            },
          ],
          repoFullName: `acme/${repoId}`,
          state: "ready",
          error: null,
          refreshing: false,
          refresh: mocks.refresh,
        },
      })
    );
    container = document.createElement("div");
    trigger = document.createElement("button");
    document.body.append(container, trigger);
    trigger.focus();
    root = createRoot(container);
    props = {
      open: false,
      repoId: "repo-a",
      repoPath: "/repo-a",
      onClose: vi.fn(),
      onSelect: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    restoreLayout();
    container.remove();
    trigger.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("returns selected domain items to any consumer and leaves closing to that consumer", async () => {
    await render({ open: true });
    selectLocal();
    act(() => filter("sessions:kanban.sidebar.githubIssues").click());
    search("no match");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("projects:workItems.noResults");
    search("Issue from repo-a");
    const issue = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect(issue).not.toBeNull();
    act(() => issue!.click());
    await act(async () => addAction().click());
    expect(props.onSelect).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: "workitem",
        title: "Local work",
        workItemContext: expect.objectContaining({ workItemId: "ABC-1" }),
        contextText: expect.stringContaining("Work item body"),
      }),
      expect.objectContaining({
        kind: "github_issue",
        pillPath: "https://github.com/acme/repo-a/issues/42",
      }),
    ]);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("can be scoped to local Work Items for a dedicated command", async () => {
    await render({ open: true, sourceFilters: ["workitem"] });

    expect(document.activeElement).toBe(
      document.querySelector<HTMLInputElement>('input[type="text"]')
    );
    expect(mocks.useWorktreeSourceData).toHaveBeenLastCalledWith({
      open: false,
      repoId: "repo-a",
      repoPath: "/repo-a",
      loadBranches: false,
    });
    expect(
      document.querySelector('[data-testid="work-item-picker-tabs"]')
    ).toBeNull();
    expect(document.body.textContent).toContain("Local work");
    expect(document.body.textContent).not.toContain("Issue from repo-a");

    selectLocal();
    await act(async () => addAction().click());
    expect(props.onSelect).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "workitem", pillPath: "project/ABC-1" }),
    ]);
  });

  it("loads only while open and drops draft selection and search after closing during a request", async () => {
    const pending = deferred<WorkspaceWorkItemsData>();
    mocks.readWorkspaceWorkItemsData.mockReturnValueOnce(pending.promise);
    await render();
    expect(mocks.readWorkspaceWorkItemsData).not.toHaveBeenCalled();
    expect(mocks.useWorktreeSourceData).not.toHaveBeenCalled();
    await render({ open: true });
    search("Issue");
    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    );
    await render({ open: false });
    const githubCallCount = mocks.useWorktreeSourceData.mock.calls.length;
    await act(async () => pending.resolve(snapshot("Stale result")));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.useWorktreeSourceData).toHaveBeenCalledTimes(githubCallCount);
    await render({ open: true });
    expect(mocks.readWorkspaceWorkItemsData).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Local work");
    expect(document.body.textContent).not.toContain("Stale result");
    expect(
      document.querySelector<HTMLInputElement>('input[type="text"]')?.value
    ).toBe("");
    expect(addAction().classList.contains("cursor-not-allowed")).toBe(true);
  });

  it("resets repository-specific results and selection when scope changes", async () => {
    await render({ open: true });
    search("Issue");
    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    );
    expect(addAction().classList.contains("cursor-not-allowed")).toBe(false);
    await render({ repoId: "repo-b", repoPath: "/repo-b" });
    expect(mocks.useWorktreeSourceData).toHaveBeenLastCalledWith({
      open: true,
      repoId: "repo-b",
      repoPath: "/repo-b",
      loadBranches: false,
    });
    expect(document.body.textContent).toContain("Issue from repo-b");
    expect(document.body.textContent).not.toContain("Issue from repo-a");
    expect(
      document.querySelector<HTMLInputElement>('input[type="text"]')?.value
    ).toBe("");
    expect(addAction().classList.contains("cursor-not-allowed")).toBe(true);
  });

  it("does not submit a selection removed by refresh", async () => {
    await render({ open: true });
    selectLocal();
    mocks.readWorkspaceWorkItemsData.mockResolvedValueOnce({
      projectEntries: [],
      standaloneWorkItems: [],
      orgs: [],
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="session-creator-work-item-picker-refresh"]'
        )!
        .click()
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(addAction().classList.contains("cursor-not-allowed")).toBe(true);
    act(() => addAction().click());
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("preserves available sources after an error and supports retry", async () => {
    mocks.readWorkspaceWorkItemsData.mockRejectedValueOnce(
      new Error("Workspace unavailable")
    );
    await render({ open: true });
    expect(document.body.textContent).toContain("Issue from repo-a");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Workspace unavailable"
    );
    act(() => filter("projects:workItems.label").click());
    expect(document.body.textContent).toContain("Workspace unavailable");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="session-creator-work-item-picker-refresh"]'
        )!
        .click()
    );
    expect(document.body.textContent).toContain("Local work");
    expect(document.body.textContent).not.toContain("Workspace unavailable");
  });

  it.each(["mask", "escape"])(
    "dismisses through %s without committing and restores focus",
    async (action) => {
      props.onClose = vi.fn(() => {
        props = { ...props, open: false };
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(WorkItemPickerModal, props)
          )
        );
      });
      await render({ open: true });
      act(() => vi.advanceTimersByTime(100));
      expect(document.activeElement).toBe(
        document.querySelector('input[type="text"]')
      );
      selectLocal();
      act(() => {
        if (action === "mask")
          document
            .querySelector("[data-spotlight-container]")!
            .previousElementSibling!.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true })
            );
        else
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          );
      });
      expect(props.onClose).toHaveBeenCalledOnce();
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(document.body.style.overflow).toBe("");
    }
  );

  it("cancels delayed initial focus on an immediate close", async () => {
    await render({ open: true });
    const input =
      document.querySelector<HTMLInputElement>('input[type="text"]')!;
    const focus = vi.spyOn(input, "focus");
    await render({ open: false });
    act(() => vi.advanceTimersByTime(100));
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles sources with Tab and Shift+Tab without losing query or draft selection", async () => {
    await render({ open: true });
    act(() => vi.advanceTimersByTime(100));
    selectLocal();
    search("work");
    const input =
      document.querySelector<HTMLInputElement>('input[type="text"]')!;
    for (const label of [
      "projects:workItems.label",
      "sessions:kanban.sidebar.githubIssues",
      "sessions:kanban.sidebar.githubPrs",
      "common:actions.all",
    ]) {
      key(input, "Tab");
      expect(filter(label).getAttribute("aria-selected")).toBe("true");
      expect(input.value).toBe("work");
      expect(document.activeElement).toBe(input);
    }
    key(input, "Tab", true);
    expect(
      filter("sessions:kanban.sidebar.githubPrs").getAttribute("aria-selected")
    ).toBe("true");
    key(input, "Tab");
    search("");
    expect(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked
    ).toBe(true);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(mocks.readWorkspaceWorkItemsData).toHaveBeenCalledOnce();
  });

  it("toggles highlighted rows with Enter and submits only through the Add action", async () => {
    await render({ open: true });
    act(() => vi.advanceTimersByTime(100));
    const input =
      document.querySelector<HTMLInputElement>('input[type="text"]')!;
    key(input, "Enter");
    expect(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked
    ).toBe(true);
    key(input, "ArrowDown");
    key(input, "Enter");
    expect(
      Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      ).every((box) => box.checked)
    ).toBe(true);
    expect(props.onSelect).not.toHaveBeenCalled();
    key(input, "ArrowDown");
    key(input, "Enter");
    expect(props.onSelect).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onSelect).mock.calls[0][0]).toHaveLength(2);
  });

  it("preserves neutral styling and readable metadata for an unknown PR state", async () => {
    mocks.useWorktreeSourceData.mockReturnValue({
      github: {
        prs: [
          {
            number: 51,
            title: "Custom PR",
            state: "pending_review",
            draft: false,
            url: "https://github.com/acme/repo/pull/51",
            author_login: "author",
            ci_status: "unavailable",
          },
        ],
        issues: [],
        repoFullName: "acme/repo",
        state: "ready",
        error: null,
        refreshing: false,
        refresh: mocks.refresh,
      },
    });
    await render({ open: true });
    const row = document.querySelector(
      '[data-testid="work-item-picker-option-github_pr:https://github.com/acme/repo/pull/51"]'
    );
    expect(row?.textContent).toContain("pending_review");
    expect(row?.textContent).toContain("@author");
    expect(row?.querySelector("svg.text-text-3")).not.toBeNull();
    expect(row?.querySelector("svg.text-success-6")).toBeNull();
  });

  it("does not let a focused tab activate the highlighted row", async () => {
    await render({ open: true });
    const issues = filter("sessions:kanban.sidebar.githubIssues");
    act(() => issues.focus());
    key(issues, "Enter");
    expect(issues.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked
    ).toBe(false);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
