// @vitest-environment jsdom
/**
 * The status bar outlives every WorkStation content host: with no real tabs
 * the code host unmounts (`hostMountPolicy.ts`), and the bar still renders.
 * These pin the left cluster — workspace identity plus the whole git cluster —
 * to the global workspace/repo atoms, so nothing here can go blank again just
 * because the Code Editor is not mounted.
 */
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { currentBranchAtom } from "@src/store/repo";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

import { EditorStatusBar } from "../EditorStatusBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@src/hooks/git", () => ({
  useRepoGitInitialization: () => ({ isGitInitialized: true }),
}));

vi.mock("@src/hooks/git/useRepoSelection", () => ({
  useRepoSelection: () => ({ selectRepo: vi.fn() }),
}));

// Git plumbing is exercised by its own suites; here we only care that the bar
// feeds it the identity it read from the atoms.
const gitCallArgs: Array<Record<string, unknown>> = [];
vi.mock("../utils/useEditorStatusBarGit", () => ({
  useEditorStatusBarGit: (options: Record<string, unknown>) => {
    gitCallArgs.push(options);
    return {
      workspaceLabel: options.repoName,
      workspaceTooltip: "",
      isMultiRoot: false,
      aheadCount: 0,
      behindCount: 0,
      workingAdditions: 0,
      workingDeletions: 0,
      needsPublish: false,
      isSyncBusy: false,
      isPublishing: false,
      canSyncDisplayedRepo: true,
      syncSpinClass: undefined,
      syncStatusLabel: null,
      handleSyncClick: () => {},
      handleFetchClick: async () => {},
      handlePullClick: async () => {},
      handleRebaseClick: async () => {},
      handlePushClick: async () => {},
      checkoutLoading: false,
    };
  },
}));

vi.mock("../CiStatusMenu", () => ({ CiStatusMenu: () => null }));
vi.mock("../GitSyncStatusMenu", () => ({ default: () => null }));
vi.mock("../PortsStatusMenu", () => ({ PortsStatusMenu: () => null }));

const folder: WorkspaceFolder = {
  id: "primary",
  name: "Primary Repo",
  path: "/tmp/orgii-primary",
  uri: "file:///tmp/orgii-primary",
  isPrimary: true,
  repoId: "primary-repo-id",
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("EditorStatusBar with no code host mounted", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    gitCallArgs.length = 0;
    store = createStore();
    store.set(workspaceFoldersAtom, [folder]);
    store.set(currentBranchAtom, "dev/align-composer-chrome");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(EditorStatusBar, { cursor: null, ...props })
        )
      );
    });
  }

  it("shows the workspace and branch without any pushed props", () => {
    render();

    expect(container.querySelector('[data-testid="status-bar-no-repo"]')).toBe(
      null
    );
    expect(
      container.querySelector('[data-testid="status-bar-repo-name"]')
        ?.textContent
    ).toContain("Primary Repo");
    expect(
      container.querySelector('[data-testid="status-bar-branch"]')?.textContent
    ).toContain("dev/align-composer-chrome");
    expect(
      container.querySelector('[data-testid="status-bar-worktree"]')
    ).not.toBe(null);
    expect(gitCallArgs[0]).toMatchObject({
      repoName: "Primary Repo",
      repoPath: "/tmp/orgii-primary",
      branchName: "dev/align-composer-chrome",
    });
  });

  it("keeps the workspace button wired to the spotlight opener", () => {
    const onRepoClick = vi.fn();
    render({ onRepoClick });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="status-bar-repo-name"]'
    );
    act(() => button?.click());

    expect(onRepoClick).toHaveBeenCalledTimes(1);
  });

  it("falls back to the add-workspace CTA only when no workspace is open", () => {
    store.set(workspaceFoldersAtom, []);
    store.set(currentBranchAtom, "");
    render();

    expect(
      container.querySelector('[data-testid="status-bar-no-repo"]')
    ).not.toBe(null);
    expect(container.querySelector('[data-testid="status-bar-branch"]')).toBe(
      null
    );
  });
});
