// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenPRItem } from "@src/api/tauri/github";
import type { SpotlightPinnedActionSectionProps } from "@src/scaffold/GlobalSpotlight/components/SpotlightPinnedActionSection";
import type { PaletteBodyProps } from "@src/scaffold/GlobalSpotlight/shell/PaletteBody";
import type { BranchItem } from "@src/scaffold/GlobalSpotlight/types";

import { BranchDropdown } from "../BranchDropdown";
import { BranchPalette } from "../BranchPalette";
import { installVirtualListTestLayout } from "./virtualListTestLayout";

const mocks = vi.hoisted(() => ({
  getGitRemotes: vi.fn(),
  getGitCredentialForRemote: vi.fn(),
  listOpenPRsLocal: vi.fn(),
  preparePullRequestBranch: vi.fn(),
  branches: [] as BranchItem[],
}));
vi.mock("@src/api/http/git/remotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/http/git/remotes")>()),
  ...mocks,
}));
vi.mock("@src/api/tauri/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/github")>()),
  ...mocks,
}));
vi.mock("@src/services/git/operations/preparePullRequestBranch", () => mocks);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../useBranchFetch", () => ({
  useBranchFetch: () => ({
    branches: mocks.branches,
    isLoading: false,
    repoPath: "/repo",
    refresh: vi.fn(),
  }),
}));
vi.mock("../useWorktreeMap", () => ({ useWorktreeMap: () => new Map() }));
vi.mock("../useBranchPalette", async () => {
  const { useSelectorKernel } =
    await import("@src/scaffold/GlobalSpotlight/palettes/core");
  return {
    useBranchPalette: (options: { isOpen: boolean; onClose: () => void }) => {
      const items = [
        { id: "main", label: "main", icon: "", type: "option" as const },
      ];
      return {
        kernel: useSelectorKernel({ ...options, items }),
        repoPath: "/repo",
        activeMode: "checkout",
        setActiveMode: vi.fn(),
        setSelectedStartPoint: vi.fn(),
        items,
        pinnedActionItems: [],
        isLoading: false,
        isCreatingBranch: false,
        getPath: () => [],
        refreshBranches: vi.fn(),
        getPlaceholder: () => "Search branches",
      };
    },
  };
});
vi.mock("@src/scaffold/GlobalSpotlight/components", async () => ({
  SpotlightFooterToggle: (
    await import("@src/scaffold/GlobalSpotlight/components/SpotlightFooterToggle")
  ).SpotlightFooterToggle,
  SPOTLIGHT_FOOTER_ACTIVE_CHIP: {},
  SpotlightPinnedActionSection: (props: SpotlightPinnedActionSectionProps) =>
    createElement(
      "div",
      { "data-pinned-layout": props.layout },
      props.items.map((item) =>
        createElement(
          "button",
          {
            key: item.id,
            disabled: item.data?.disabled,
            onClick: () => props.onItemSelect(item),
          },
          item.label
        )
      )
    ),
}));
// Keep production keyboard navigation; replace only shell styling/positioning.
vi.mock("@src/scaffold/GlobalSpotlight/shell", async () => {
  const { SpotlightItemList } =
    await import("@src/scaffold/GlobalSpotlight/components/SpotlightItemList");
  return {
    SpotlightShell: ({ children }: { children: React.ReactNode }) => children,
    ShellFooterAction: ({ children }: { children: React.ReactNode }) =>
      children,
    PaletteBody: (props: PaletteBodyProps) =>
      createElement(
        "div",
        null,
        props.inputLeadingSlot,
        createElement("input", {
          ref: props.kernel.inputRef,
          value: props.kernel.searchQuery,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            props.kernel.setSearchQuery(event.target.value),
          onKeyDown: props.kernel.handleKeyDown,
          "aria-label": props.inputAriaLabel,
          placeholder: props.placeholder,
        }),
        props.contentOverride ??
          createElement(SpotlightItemList, {
            items: props.items,
            selectedIndex: props.kernel.selectedIndex,
            onItemSelect: props.kernel.handleItemClick,
            onItemHover: props.kernel.setSelectedIndex,
            searchQuery: props.kernel.searchQuery,
            onLoadMore: props.onLoadMore,
            fixedHeight: true,
            containerHeight: 350,
          }),
        props.afterListSlot
      ),
  };
});
vi.mock("@src/hooks/dropdown", async () => {
  const { useDropdownListNavigation } =
    await import("@src/hooks/dropdown/useDropdownListNavigation");
  return {
    useDropdownEngine: (options: {
      open: boolean;
      listNavigation: {
        items: OpenPRItem[];
        onSelect: (pr: OpenPRItem) => void;
        isItemSelectable?: () => boolean;
        initialSelectedIndex?: number;
      };
    }) => ({
      isPositioned: options.open,
      panelRef: React.useRef(null),
      panelPosition: { top: 20, left: 20, width: 420 },
      keyboard: useDropdownListNavigation({
        ...options.listNavigation,
        isOpen: options.open,
      }),
    }),
  };
});

let root: Root;
let container: HTMLDivElement;
let restoreLayout: () => void;
const onSelect = vi.fn();
const onClose = vi.fn();
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const prs = [
  {
    number: 42,
    state: "open",
    title: "Fix launch",
    head_branch: "fix/launch",
    base_branch: "main",
    author_login: "alice",
  },
  {
    number: 73,
    state: "open",
    title: "Add branch picker",
    head_branch: "feature/picker",
    base_branch: "main",
    author_login: "bob",
    draft: true,
  },
];
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  restoreLayout = installVirtualListTestLayout();
  mocks.branches = [{ name: "main", isCurrent: true, isRemote: false }];
  mocks.getGitRemotes.mockResolvedValue({
    remotes: [{ name: "origin", url: "git@github.com:org/app.git" }],
  });
  mocks.getGitCredentialForRemote.mockResolvedValue(null);
  mocks.listOpenPRsLocal.mockResolvedValue(prs);
  mocks.preparePullRequestBranch.mockResolvedValue("fix/launch");
  onSelect.mockResolvedValue(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreLayout();
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});
function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")];
}
async function clickTab(tab: "branches" | "prs") {
  const button = buttons().find(
    (item) => item.textContent === `selectors.branch.tabs.${tab}`
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function search(query: string) {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("branch picker tabs", () => {
  it.each(["global", "create-session"] as const)(
    "demand-loads PRs for %s and preserves cancellation",
    async (variant) => {
      await act(async () =>
        root.render(
          createElement(BranchPalette, {
            isOpen: true,
            repoId: "repo",
            repoPath: "/repo",
            onSelect,
            onClose,
            variant,
          })
        )
      );
      expect(mocks.listOpenPRsLocal).not.toHaveBeenCalled();
      await clickTab("prs");
      expect(container.textContent).toContain("Fix launch");
      expect(container.textContent).toContain("#73");
      expect(container.textContent).not.toContain("org/app");
      expect(container.querySelector("input")?.placeholder).toBe(
        "selectors.branch.placeholders.pullRequests"
      );
      const footer = container.querySelector(
        '[data-pinned-layout="twoColumn"]'
      );
      expect(footer?.textContent).toBe(
        "selectors.branch.actions.refreshPullRequests"
      );
      const searchInput = container.querySelector("input")!;
      await act(async () =>
        searchInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true })
        )
      );
      await act(async () =>
        searchInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
      expect(onSelect).not.toHaveBeenCalled();
      const input = await search("#42");
      expect(container.textContent).not.toContain("Add branch picker");
      await act(async () =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(onSelect).toHaveBeenCalledWith(
        "fix/launch",
        expect.objectContaining({ name: "fix/launch" })
      );
      expect(onClose).not.toHaveBeenCalled();
      onSelect.mockResolvedValueOnce(true);
      await act(async () =>
        container
          .querySelector<HTMLElement>('[data-spotlight-item-id="pr:42"]')!
          .click()
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      await clickTab("branches");
      expect(container.textContent).toContain("main");
    }
  );
  it("uses the same PR tab in the compact dropdown, with arrow/Enter selection", async () => {
    await act(async () =>
      root.render(
        createElement(BranchDropdown, {
          isOpen: true,
          repoId: "repo",
          repoPath: "/repo",
          anchorRef: { current: container },
          onSelect,
          onClose,
        })
      )
    );
    expect(mocks.listOpenPRsLocal).not.toHaveBeenCalled();
    await clickTab("prs");
    const input = await search("bob");
    expect(document.body.textContent).not.toContain("Fix launch");
    expect(document.body.textContent).toContain("Add branch picker");
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    );
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(mocks.preparePullRequestBranch).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 73 })
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it("does not checkout a prepared branch after the picker closes", async () => {
    let finish!: (name: string) => void;
    mocks.preparePullRequestBranch.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    await act(async () =>
      root.render(
        createElement(BranchPalette, {
          isOpen: true,
          repoId: "repo",
          onSelect,
          onClose,
        })
      )
    );
    await clickTab("prs");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-spotlight-item-id="pr:42"]')!
        .click()
    );
    await act(async () => root.render(null));
    await act(async () => finish("fix/launch"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("switches tabs with Ctrl+Tab and activates focused tabs without checking out a row", async () => {
    await act(async () =>
      root.render(
        createElement(BranchDropdown, {
          isOpen: true,
          repoId: "repo",
          repoPath: "/repo",
          anchorRef: { current: container },
          onSelect,
          onClose,
        })
      )
    );
    const prTab = buttons().find(
      (button) => button.textContent === "selectors.branch.tabs.prs"
    )!;
    await act(async () =>
      prTab.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    );
    expect(document.body.textContent).toContain("Fix launch");
    expect(onSelect).not.toHaveBeenCalled();
    const input = document.querySelector("input")!;
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    );
    expect(document.body.textContent).not.toContain("Fix launch");
    expect(document.body.textContent).toContain("main");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("virtualizes 10,000 branches and keeps End, search and Enter aligned", async () => {
    mocks.branches = Array.from({ length: 10_000 }, (_, index) => ({
      name: `branch-${String(index).padStart(5, "0")}`,
      isCurrent: false,
      isRemote: false,
    }));
    await act(async () =>
      root.render(
        createElement(BranchDropdown, {
          isOpen: true,
          repoId: "repo",
          repoPath: "/repo",
          anchorRef: { current: container },
          onSelect,
          onClose,
        })
      )
    );
    expect(
      document.querySelectorAll('[data-testid^="branch-dropdown-row-"]').length
    ).toBeLessThan(25);
    const input = document.querySelector("input")!;
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true })
      )
    );
    expect(
      document.querySelector('[data-testid="branch-dropdown-row-branch-09999"]')
    ).not.toBeNull();
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(onSelect).toHaveBeenLastCalledWith(
      "branch-09999",
      expect.any(Object)
    );
    await search("branch-00003");
    expect(
      document.querySelectorAll('[data-testid^="branch-dropdown-row-"]')
    ).toHaveLength(1);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    );
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(onSelect).toHaveBeenLastCalledWith(
      "branch-00003",
      expect.any(Object)
    );
  });

  it.each(["spotlight", "dropdown"] as const)(
    "preserves keyboard focus on Load more after a %s page is appended",
    async (presentation) => {
      mocks.listOpenPRsLocal.mockImplementation((_repo, _size, { page }) =>
        Promise.resolve(
          Array.from({ length: 50 }, (_, index) => ({
            ...prs[0],
            number: (page - 1) * 50 + index + 1,
          }))
        )
      );
      const shared = {
        isOpen: true,
        repoId: "repo",
        repoPath: "/repo",
        onSelect,
        onClose,
      };
      await act(async () =>
        root.render(
          presentation === "spotlight"
            ? createElement(BranchPalette, shared)
            : createElement(BranchDropdown, {
                ...shared,
                anchorRef: { current: container },
              })
        )
      );
      await clickTab("prs");
      const input = document.querySelector("input")!;
      const keys =
        presentation === "spotlight" ? ["Tab", "ArrowDown"] : ["End"];
      for (const key of keys)
        await act(async () =>
          input.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true })
          )
        );
      await act(async () =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
      await act(async () =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(3);
      expect(mocks.preparePullRequestBranch).not.toHaveBeenCalled();
    }
  );

  it.each(["spotlight", "dropdown"] as const)(
    "loads PR pages on scroll in %s without rendering every row",
    async (presentation) => {
      mocks.listOpenPRsLocal.mockImplementation((_repo, _size, { page }) =>
        Promise.resolve(
          Array.from({ length: 50 }, (_, index) => ({
            ...prs[index % 2],
            number: (page - 1) * 50 + index + 1,
          }))
        )
      );
      const shared = {
        isOpen: true,
        repoId: "repo",
        repoPath: "/repo",
        onSelect,
        onClose,
      };
      await act(async () =>
        root.render(
          presentation === "spotlight"
            ? createElement(BranchPalette, shared)
            : createElement(BranchDropdown, {
                ...shared,
                anchorRef: { current: container },
              })
        )
      );
      await clickTab("prs");
      expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(1);
      const selector =
        presentation === "spotlight"
          ? '[data-spotlight-item-id^="pr:"]'
          : '[data-testid^="branch-picker-pr-"]';
      expect(document.querySelectorAll(selector).length).toBeLessThan(25);
      expect(document.querySelector('[data-pr-status="draft"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain(
        "selectors.branch.labels.draft"
      );
      const scroller =
        presentation === "spotlight"
          ? document.querySelector<HTMLElement>(".spotlight-scrollable")!
          : document.querySelector<HTMLElement>(".scrollbar-overlay")!;
      await act(async () => {
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
      expect(mocks.listOpenPRsLocal).toHaveBeenLastCalledWith("org/app", 50, {
        page: 2,
        includeMetadata: true,
      });
      expect(document.querySelectorAll(selector).length).toBeLessThan(25);
      await search("unmatched query");
      expect(document.querySelectorAll(selector)).toHaveLength(0);
      expect(mocks.listOpenPRsLocal).toHaveBeenCalledTimes(2);
      expect(
        buttons().some((button) => button.textContent === "actions.loadMore")
      ).toBe(true);
    }
  );
});
