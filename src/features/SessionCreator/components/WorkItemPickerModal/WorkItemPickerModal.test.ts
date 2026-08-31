// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceWorkItemsData } from "@src/api/http/project";

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

function button(label: string) {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button")
  ).find((element) => element.textContent?.trim() === label);
  expect(result).toBeDefined();
  return result!;
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
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const render = async (changes: Partial<WorkItemPickerModalProps> = {}) => {
    props = { ...props, ...changes };
    await act(async () =>
      root.render(createElement(WorkItemPickerModal, props))
    );
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
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
    container.remove();
    trigger.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("returns selected domain items to any consumer and leaves closing to that consumer", async () => {
    await render({ open: true });
    selectLocal();
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="work-item-picker-filter-github_issue"]'
        )!
        .click()
    );
    search("no match");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("projects:workItems.noResults");
    search("Issue from repo-a");
    const issue = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect(issue).not.toBeNull();
    act(() => issue!.click());
    await act(async () => button("common:actions.add").click());
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
    expect(button("common:actions.add").disabled).toBe(true);
  });

  it("resets repository-specific results and selection when scope changes", async () => {
    await render({ open: true });
    search("Issue");
    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    );
    expect(button("common:actions.add").disabled).toBe(false);
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
    expect(button("common:actions.add").disabled).toBe(true);
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
    expect(button("common:actions.add").disabled).toBe(true);
    act(() => button("common:actions.add").click());
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
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="work-item-picker-filter-workitem"]'
        )!
        .click()
    );
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

  it.each(["cancel", "close", "mask", "escape"])(
    "dismisses through %s without committing and restores focus",
    async (action) => {
      props.onClose = vi.fn(() => {
        props = { ...props, open: false };
        root.render(createElement(WorkItemPickerModal, props));
      });
      await render({ open: true });
      act(() => vi.advanceTimersByTime(100));
      expect(document.activeElement).toBe(
        document.querySelector('input[type="text"]')
      );
      selectLocal();
      act(() => {
        if (action === "cancel") button("common:actions.cancel").click();
        else if (action === "close")
          document
            .querySelector<HTMLButtonElement>('button[title="Close"]')!
            .click();
        else if (action === "mask")
          document.querySelector<HTMLElement>(".liquid-modal-mask")!.click();
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

  it("keeps keyboard focus inside as the Add action becomes enabled", async () => {
    await render({ open: true });
    const close = document.querySelector<HTMLButtonElement>(
      'button[title="Close"]'
    )!;
    const cancel = button("common:actions.cancel");
    const add = button("common:actions.add");
    const tab = (element: HTMLElement, shiftKey = false) => {
      act(() => {
        element.focus();
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey,
            bubbles: true,
            cancelable: true,
          })
        );
      });
    };
    expect(add.disabled).toBe(true);
    tab(cancel);
    expect(document.activeElement).toBe(close);
    tab(close, true);
    expect(document.activeElement).toBe(cancel);
    selectLocal();
    expect(add.disabled).toBe(false);
    tab(add);
    expect(document.activeElement).toBe(close);
    tab(close, true);
    expect(document.activeElement).toBe(add);
  });
});
