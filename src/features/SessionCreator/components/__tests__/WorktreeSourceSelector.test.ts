// @vitest-environment jsdom
import React, { act, createElement } from "react";
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

import { resolvePrWorktreeBase } from "@src/api/tauri/github";

import WorktreeSourceSelector from "../WorktreeSourceSelector";

const testState = vi.hoisted(() => ({
  loadOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; value?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@src/api/tauri/github", () => ({
  resolvePrWorktreeBase: vi.fn(),
}));

vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/useWorktreeMap",
  () => ({ useWorktreeMap: () => new Map() })
);

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: (options: {
    listNavigation: {
      items: unknown[];
      onSelect: (item: unknown) => void;
    };
  }) => ({
    isPositioned: true,
    panelRef: { current: null },
    panelPosition: { top: 20, left: 20, width: 360 },
    keyboard: {
      getItemProps: (index: number) => ({
        "data-dropdown-item-index": index,
        "aria-selected": false,
        onMouseEnter: vi.fn(),
        onClick: () =>
          options.listNavigation.onSelect(options.listNavigation.items[index]),
      }),
    },
  }),
}));

vi.mock("@src/scaffold/GlobalSpotlight/palettes/core", () => ({
  useSelectorKernel: () => ({
    searchQuery: "",
    setSearchQuery: vi.fn(),
    setSearchQueryRaw: vi.fn(),
    selectedIndex: 0,
    setSelectedIndex: vi.fn(),
    inputRef: { current: null },
    handleKeyDown: vi.fn(),
    handleItemClick: vi.fn(),
    focusInput: vi.fn(),
    findFirstSelectable: () => 0,
  }),
}));

vi.mock("../useWorktreeSourceData", () => ({
  useWorktreeSourceData: (options: Record<string, unknown>) => {
    testState.loadOptions.push(options);
    return {
      branch: {
        options: [
          {
            name: "develop",
            isCurrent: true,
            isRemote: false,
          },
        ],
        state: "ready",
        error: null,
        refreshing: false,
        refresh: vi.fn(),
      },
      github: {
        prs: [
          {
            number: 42,
            title: "Fix launch flow",
            head_branch: "fix/launch-flow",
            base_branch: "develop",
          },
        ],
        issues: [],
        repoFullName: "acme/orgii",
        state: "ready",
        error: null,
        refreshing: false,
        refresh: vi.fn(),
      },
    };
  },
}));

vi.mock("@src/scaffold/GlobalSpotlight/shell", async () => {
  const ReactModule = await import("react");
  return {
    SpotlightShell: ({
      isOpen,
      children,
    }: {
      isOpen: boolean;
      children: React.ReactNode;
    }) =>
      isOpen
        ? ReactModule.createElement(
            "div",
            { "data-testid": "spotlight-shell" },
            children
          )
        : null,
    PaletteBody: ({
      items,
      inputLeadingSlot,
    }: {
      items: Array<{
        id: string;
        label: string;
        data?: { isHeader?: boolean };
        action?: () => void;
      }>;
      inputLeadingSlot?: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "div",
        null,
        inputLeadingSlot,
        ...items.map((item) =>
          item.data?.isHeader
            ? ReactModule.createElement("div", { key: item.id }, item.label)
            : ReactModule.createElement(
                "button",
                {
                  key: item.id,
                  type: "button",
                  "data-testid": `source-item-${item.id}`,
                  onClick: item.action,
                },
                item.label
              )
        )
      ),
  };
});

const mockedResolvePrWorktreeBase = vi.mocked(resolvePrWorktreeBase);
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("WorktreeSourceSelector", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;
  let onSelect: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.loadOptions.length = 0;
    mockedResolvePrWorktreeBase.mockReset();
    onClose = vi.fn();
    onSelect = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(
        createElement(WorktreeSourceSelector, {
          isOpen: true,
          presentation: "spotlight",
          anchorRef: React.createRef<HTMLElement>(),
          repoId: "repo-a",
          repoPath: "/repo/a",
          currentBranchName: "develop",
          onClose,
          onSelect,
        })
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("loads branches first and commits a branch source directly", () => {
    expect(testState.loadOptions.at(-1)).toMatchObject({
      loadBranches: true,
      loadGithub: false,
    });

    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="source-item-branch:develop"]'
    );
    expect(row).not.toBeNull();

    act(() => row?.click());

    expect(onSelect).toHaveBeenCalledWith({
      repoKey: "id:repo-a",
      source: {
        kind: "branch",
        label: "Branch: develop",
        baseBranch: "develop",
        sourceRef: "branch:develop",
        title: "develop",
      },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders the same Branch / PR control in the anchored dropdown", () => {
    act(() => {
      root.render(
        createElement(WorktreeSourceSelector, {
          isOpen: true,
          presentation: "dropdown",
          anchorRef: React.createRef<HTMLElement>(),
          repoId: "repo-a",
          repoPath: "/repo/a",
          currentBranchName: "develop",
          onClose,
          onSelect,
        })
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(
      document
        .querySelector('[data-testid="worktree-source-mode-switch"]')
        ?.getAttribute("aria-label")
    ).toBe("Select branch or pull request");
    expect(
      dialog?.firstElementChild?.firstElementChild?.getAttribute("data-testid")
    ).toBe("worktree-source-mode-switch");
    expect(
      document.querySelector(
        '[data-testid="worktree-source-row-branch:develop"]'
      )
    ).not.toBeNull();
  });

  it("switches to PR mode lazily and resolves the selected PR head", async () => {
    mockedResolvePrWorktreeBase.mockResolvedValue({
      baseRef: "abc123",
      headSha: "abc123",
      branchNameOverride: "fix/launch-flow",
      compareBaseRef: "refs/remotes/origin/develop",
      source: "branch",
    });

    const prModeButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "PR"
    );
    expect(prModeButton).toBeDefined();

    act(() => prModeButton?.click());
    expect(testState.loadOptions.at(-1)).toMatchObject({
      loadBranches: false,
      loadGithub: true,
    });

    const prRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="source-item-pr:42"]'
    );
    expect(prRow?.textContent).toContain("#42 Fix launch flow");

    await act(async () => {
      prRow?.click();
      await Promise.resolve();
    });

    expect(mockedResolvePrWorktreeBase).toHaveBeenCalledWith({
      repoPath: "/repo/a",
      prNumber: 42,
      headBranch: "fix/launch-flow",
      baseBranch: "develop",
    });
    expect(onSelect).toHaveBeenCalledWith({
      repoKey: "id:repo-a",
      source: expect.objectContaining({
        sourceRef: "pr:42",
        resolvedBaseRef: "abc123",
        baseBranch: "fix/launch-flow",
      }),
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores a PR resolution that finishes after the selector closes", async () => {
    let finishResolution:
      | ((value: Awaited<ReturnType<typeof resolvePrWorktreeBase>>) => void)
      | undefined;
    mockedResolvePrWorktreeBase.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve;
      })
    );

    const prModeButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "PR"
    );
    act(() => prModeButton?.click());

    const prRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="source-item-pr:42"]'
    );
    act(() => prRow?.click());

    act(() => {
      root.render(
        createElement(WorktreeSourceSelector, {
          isOpen: false,
          presentation: "spotlight",
          anchorRef: React.createRef<HTMLElement>(),
          repoId: "repo-a",
          repoPath: "/repo/a",
          currentBranchName: "develop",
          onClose,
          onSelect,
        })
      );
    });

    await act(async () => {
      finishResolution?.({
        baseRef: "abc123",
        headSha: "abc123",
        branchNameOverride: "fix/launch-flow",
        compareBaseRef: "refs/remotes/origin/develop",
        source: "branch",
      });
      await Promise.resolve();
    });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
