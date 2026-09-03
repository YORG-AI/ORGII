// @vitest-environment jsdom
import i18next from "i18next";
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import common from "@src/i18n/locales/en/common.json";
import navigation from "@src/i18n/locales/en/navigation.json";
import { createChatPanelTerminalAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { workspaceGitStatusMapAtom } from "@src/store/git";
import {
  closeMiniTerminalAtom,
  miniTerminalCollapsedAtom,
  openMiniTerminalAtom,
  releaseMiniTerminalSessionAtom,
} from "@src/store/ui/miniTerminalAtom";
import {
  sideChatSessionIdAtom,
  sideChatVisibleAtom,
} from "@src/store/ui/sideChatAtom";
import {
  activeWorkspaceIdAtom,
  workspaceFoldersAtom,
} from "@src/store/workspace";
import {
  editorAddTerminalSessionAtom,
  markTerminalInitializedAtom,
  terminalSessionsAtom,
} from "@src/store/workstation/codeEditor/terminal";
import { workstationLayoutAtom } from "@src/store/workstation/tabs";

import { FocusedChatWorkstationRail } from ".";
import type {
  FocusedChatRailSubagent,
  FocusedChatSessionContext,
} from "./types";

const gitMocks = vi.hoisted(() => ({
  useWorkingTreeDiffTotals: vi.fn(
    (_repoId: string | undefined, repoPath: string | undefined) =>
      repoPath?.includes("secondary")
        ? { additions: 8, deletions: 2 }
        : repoPath
          ? { additions: 12, deletions: 4 }
          : { additions: 0, deletions: 0 }
  ),
}));

vi.mock("@src/hooks/git/useActiveRepoRef", () => ({
  useActiveRepoRef: () => ({ repoId: null, repoPath: "" }),
}));
vi.mock("@src/hooks/git/useRepoSelection", () => ({
  useRepoSelection: () => ({ currentBranch: "" }),
}));
vi.mock("@src/hooks/git/useWorkingTreeDiffTotals", () => ({
  useWorkingTreeDiffTotals: gitMocks.useWorkingTreeDiffTotals,
}));
vi.mock("@src/hooks/git/useBranchPullRequestStatus", () => ({
  useBranchPullRequestStatus: () => ({ ciStatus: null, pr: null }),
}));
vi.mock("@src/hooks/tabHost/useCloseTabWithGuard", () => ({
  useCloseTabWithGuard: () => vi.fn(),
}));
// Exercise the parent projection and both real section renderers without
// launching a PTY or depending on popup positioning/animation in jsdom.
vi.mock("./WorkstationTrailTerminal", () => ({
  WorkstationTrailTerminal: () => null,
}));
vi.mock("@src/components/FileTypeIcon", () => ({ default: () => null }));
vi.mock("@src/components/Dropdown", () => ({
  default: ({
    children,
    droplist,
  }: React.PropsWithChildren<{
    droplist: React.ReactNode;
  }>) => React.createElement(React.Fragment, null, children, droplist),
}));

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { common, navigation } },
  interpolation: { escapeValue: false },
});

describe.each(["wide rail", "compact menu"])(
  "environment tabs in %s",
  (view) => {
    let root: Root;
    let container: HTMLDivElement;
    let menuHost: HTMLDivElement;
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
      localStorage.clear();
      sessionStorage.clear();
      gitMocks.useWorkingTreeDiffTotals.mockClear();
      store = createStore();
      container = document.createElement("div");
      menuHost = document.createElement("div");
      document.body.append(container, menuHost);
      root = createRoot(container);
      store.set(terminalSessionsAtom, []);
      store.set(workstationLayoutAtom, {
        mainPane: {
          tabs: [
            {
              id: "file:readme",
              type: "file",
              title: "README.md",
              data: { filePath: "/workspace/README.md" },
            },
          ],
          activeTabId: "file:readme",
        },
      });
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      menuHost.remove();
      localStorage.clear();
      sessionStorage.clear();
      vi.restoreAllMocks();
      vi.useRealTimers();
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    });

    function addStationTerminal(name: string) {
      const id = store.set(editorAddTerminalSessionAtom, {
        name,
        bypassCreationCooldown: true,
      });
      store.set(markTerminalInitializedAtom, id);
      return id;
    }

    async function mount(
      subagents?: FocusedChatRailSubagent[],
      sessionContext?: FocusedChatSessionContext
    ) {
      await act(async () => {
        root.render(
          React.createElement(
            Provider,
            { store },
            React.createElement(
              I18nextProvider,
              { i18n },
              React.createElement(
                MemoryRouter,
                null,
                React.createElement(FocusedChatWorkstationRail, {
                  compactMenuHost: menuHost,
                  conversationMinimapHostRef: () => {},
                  sessionContext,
                  subagents,
                })
              )
            )
          )
        );
      });
    }

    function tabSection() {
      const host = view === "wide rail" ? container : menuHost;
      return [...host.querySelectorAll("section")].find((section) =>
        section.textContent?.includes("Open Tabs")
      );
    }

    it("puts cloud session identity above the local environment", async () => {
      await mount(undefined, {
        environmentKind: "cloud",
        owner: {
          identityId: "user-alice",
          displayName: "Alice",
          avatarUrl: "https://example.com/alice.png",
        },
        repoName: "ORGII",
      });

      const host = view === "wide rail" ? container : menuHost;
      const text = host.textContent ?? "";
      expect(text).toContain("Alice");
      expect(text).not.toContain("@Alice");
      expect(text.indexOf("Session Env")).toBeLessThan(
        text.indexOf("Local env")
      );
      expect(text.indexOf("Alice")).toBeLessThan(text.indexOf("Cloud"));
      expect(text.indexOf("Alice")).toBeLessThan(text.indexOf("Local env"));
      expect(
        host.querySelector('[data-owner-id="user-alice"] img')
      ).not.toBeNull();
    });

    if (view === "wide rail") {
      it("shows shortcut tooltips on collapsed icons and disposes them on expansion", async () => {
        vi.useFakeTimers();
        await mount();
        act(() =>
          container
            .querySelector('[data-icon="chevrons-right"]')!
            .closest("button")!
            .click()
        );

        for (const [label, key] of [
          ["Review", "E"],
          ["Terminal", "J"],
          ["Files", "G"],
          ["Browser", null],
        ]) {
          const button = container.querySelector<HTMLButtonElement>(
            `button[aria-label="${label}"]`
          )!;
          expect(button).not.toBeNull();
          expect(button.hasAttribute("title")).toBe(false);
          act(() =>
            button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
          );
          act(() => vi.advanceTimersByTime(200));
          act(() => vi.advanceTimersByTime(32));

          const tooltip = document.querySelector(".native-tooltip")!;
          expect(tooltip?.textContent).toContain(label);
          expect(tooltip.classList.contains("native-tooltip-visible")).toBe(
            true
          );
          expect(container.contains(tooltip)).toBe(false);
          const keys = tooltip.querySelectorAll("kbd");
          expect(keys).toHaveLength(key ? 2 : 0);
          if (key) expect(keys[1].textContent).toBe(key);

          act(() =>
            button.dispatchEvent(
              new MouseEvent("mouseout", {
                bubbles: true,
                relatedTarget: document.body,
              })
            )
          );
          act(() => vi.advanceTimersByTime(100));
          expect(document.querySelector(".native-tooltip")).toBeNull();
        }

        // Expanding before the delay expires must not leave a stale popup.
        const review = container.querySelector('button[aria-label="Review"]')!;
        act(() =>
          review.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
        );
        act(() =>
          container
            .querySelector('[data-icon="chevrons-left"]')!
            .closest("button")!
            .click()
        );
        act(() => vi.advanceTimersByTime(250));
        expect(document.querySelector(".native-tooltip")).toBeNull();
      });

      it("folds the workspace group from the panel title and widens the gap to section rhythm", async () => {
        await mount();
        const titleButton = () =>
          [...container.querySelectorAll("button")].find((candidate) =>
            candidate.textContent?.includes("Local env")
          )!;
        const headerRow = () => titleButton().parentElement!;

        expect(headerRow().className).toContain("mb-1");
        expect(container.textContent).toContain("Review");

        act(() => titleButton().click());
        expect(container.textContent).not.toContain("Review");
        expect(headerRow().className).toContain("mb-3");

        act(() => titleButton().click());
        expect(container.textContent).toContain("Review");
        expect(headerRow().className).toContain("mb-1");
      });
    }

    it("expands only the first multi-workspace root and loads secondary Git totals on demand", async () => {
      store.set(activeWorkspaceIdAtom, "workspace:multi");
      store.set(workspaceFoldersAtom, [
        {
          id: "primary",
          name: "Primary Repo",
          path: "/workspace/primary",
          uri: "file:///workspace/primary",
          isPrimary: true,
          kind: "git",
        },
        {
          id: "secondary",
          name: "Secondary Repo",
          path: "/workspace/secondary",
          uri: "file:///workspace/secondary",
          isPrimary: false,
          kind: "git",
        },
      ]);
      const status = (branch: string) => ({
        current_branch: branch,
        current_upstream_branch: null,
        current_tip: "abc123",
        branch_ahead_behind: null,
        exists: true,
        merge_head_found: false,
        squash_msg_found: false,
        rebase_in_progress: false,
        cherry_pick_in_progress: false,
        working_directory: { files: [] },
        do_conflicted_files_exist: false,
      });
      store.set(
        workspaceGitStatusMapAtom,
        new Map([
          ["/workspace/primary", status("primary-branch")],
          ["/workspace/secondary", status("secondary-branch")],
        ])
      );

      await mount();

      const host = view === "wide rail" ? container : menuHost;
      const secondaryToggle = host.querySelector<HTMLButtonElement>(
        '[data-workstation-group-toggle="workspace:secondary"]'
      )!;
      expect(host.textContent).toContain("Primary Repo");
      expect(host.textContent).toContain("primary-branch");
      expect(host.textContent).toContain("Secondary Repo");
      expect(host.textContent).not.toContain("secondary-branch");
      expect(secondaryToggle.getAttribute("aria-expanded")).toBe("false");

      const requestedPaths = () =>
        gitMocks.useWorkingTreeDiffTotals.mock.calls.map((call) => call[1]);
      expect(requestedPaths()).toContain("/workspace/primary");
      expect(requestedPaths()).not.toContain("/workspace/secondary");

      act(() => secondaryToggle.click());

      expect(host.textContent).toContain("secondary-branch");
      expect(secondaryToggle.getAttribute("aria-expanded")).toBe("true");
      expect(requestedPaths()).toContain("/workspace/secondary");
    });

    it("lists My Station files and terminals without docked or chat-panel terminals", async () => {
      addStationTerminal("Station shell");
      const pinned = addStationTerminal("Pinned shell");
      store.set(openMiniTerminalAtom, pinned);
      const chatTerminal = store.set(createChatPanelTerminalAtom, {
        name: "Chat shell",
      });
      store.set(markTerminalInitializedAtom, chatTerminal);
      store.set(terminalSessionsAtom, (sessions) => [
        ...sessions,
        { id: "agent-pty-task", name: "Agent shell", isActive: false },
      ]);
      store.set(markTerminalInitializedAtom, "agent-pty-task");

      await mount();

      expect(tabSection()?.textContent).toContain("README.md");
      expect(tabSection()?.textContent).toContain("Station shell");
      expect(tabSection()?.textContent).not.toContain("Pinned shell");
      expect(tabSection()?.textContent).not.toContain("Chat shell");
      expect(tabSection()?.textContent).not.toContain("Agent shell");
      expect(store.get(terminalSessionsAtom)).toHaveLength(4);
    });

    it("folds subagents by default and lists the rest in the load-more submenu", async () => {
      const subagents: FocusedChatRailSubagent[] = Array.from(
        { length: 6 },
        (_, index) => ({
          sessionId: `parent:subagent:${index}`,
          name: "Explore",
          description: `Task ${index}`,
          status: index === 0 ? "running" : "completed",
        })
      );
      await mount(subagents);

      const host = view === "wide rail" ? container : menuHost;
      const subagentSection = () =>
        [...host.querySelectorAll("section")].find((section) =>
          section.textContent?.includes("Subagents")
        );

      // Default collapsed: heading only, no rows.
      expect(subagentSection()?.textContent).not.toContain("Task 0");

      act(() =>
        host
          .querySelector<HTMLButtonElement>(
            '[data-workstation-group-toggle="subagents"]'
          )!
          .click()
      );

      const expanded = subagentSection()!;
      for (const label of ["Task 0", "Task 1", "Task 2", "Task 3", "Task 4"]) {
        expect(expanded.textContent).toContain(label);
      }
      expect(expanded.textContent).not.toContain("Task 5");
      expect(expanded.textContent).toContain("Load more (+1)");
      // Status is a glyph with a localized tooltip, not row text.
      expect(expanded.textContent).not.toContain("Completed");
      expect(
        expanded.querySelector(
          '[title="Completed"] [data-icon="check-circle-2"]'
        )
      ).not.toBeNull();

      // The sixth row opens the second-level panel with the full list.
      act(() =>
        subagentSection()!
          .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
          .click()
      );
      const submenu = document.querySelector(
        '[data-testid="workstation-trail-subagents-submenu"]'
      );
      expect(submenu).not.toBeNull();
      expect(container.contains(submenu)).toBe(false);
      for (const label of ["Task 0", "Task 5"]) {
        expect(submenu!.textContent).toContain(label);
      }
      // Title only — no secondary agent-name text, no status words.
      expect(submenu!.textContent).not.toContain("Explore");
      expect(submenu!.textContent).not.toContain("Completed");

      // Picking a subagent opens it in the side chat and closes the panel.
      const submenuRows = [...submenu!.querySelectorAll('[role="menuitem"]')];
      const lastRow = submenuRows[submenuRows.length - 1] as HTMLElement;
      act(() => lastRow.click());
      expect(store.get(sideChatVisibleAtom)).toBe(true);
      expect(store.get(sideChatSessionIdAtom)).toBe("parent:subagent:5");
      expect(
        document.querySelector(
          '[data-testid="workstation-trail-subagents-submenu"]'
        )
      ).toBeNull();
    });

    it("keeps pins excluded while collapsed and restores them only on release", async () => {
      const first = addStationTerminal("First shell");
      const second = addStationTerminal("Second shell");
      await mount();
      expect(tabSection()?.textContent).toContain("First shell");
      expect(tabSection()?.textContent).toContain("Second shell");

      await act(async () => {
        store.set(openMiniTerminalAtom, first);
        store.set(openMiniTerminalAtom, second);
        store.set(miniTerminalCollapsedAtom, true);
      });
      expect(tabSection()?.textContent).not.toContain("First shell");
      expect(tabSection()?.textContent).not.toContain("Second shell");

      await act(async () => store.set(releaseMiniTerminalSessionAtom, first));
      expect(tabSection()?.textContent).toContain("First shell");
      expect(tabSection()?.textContent).not.toContain("Second shell");

      await act(async () => store.set(closeMiniTerminalAtom));
      expect(tabSection()?.textContent).toContain("First shell");
      expect(tabSection()?.textContent).toContain("Second shell");
      expect(store.get(terminalSessionsAtom)).toHaveLength(2);
    });
  }
);
