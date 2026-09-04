// @vitest-environment jsdom
import React, { act } from "react";
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

import { CiStatusMenu } from "../CiStatusMenu";
import { STATUS_BAR_TOKENS } from "../statusBarTokens";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  status: {
    checks: {
      sha: "abc",
      state: "success",
      check_runs: [],
      statuses: [],
    },
    ciStatus: "success",
    lastFetchedAt: Date.UTC(2026, 8, 4, 7, 54),
    pr: {
      number: 1264,
      state: "open",
      url: "https://github.com/acme/repo/pull/1264",
    },
    refreshing: false,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));

vi.mock("@src/config/timezone", () => ({
  resolveTimeZoneForIntl: () => "UTC",
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    close: vi.fn(),
    isOpen: true,
    isPositioned: true,
    panelPosition: { top: 10, left: 10 },
    panelRef: { current: null },
    toggle: vi.fn(),
    triggerRef: { current: null },
  }),
}));

vi.mock("@src/hooks/git/useActiveRepoRef", () => ({
  useActiveRepoRef: () => ({ repoId: "repo-1", repoPath: "/repo" }),
}));

vi.mock("@src/hooks/git/useBranchPullRequestStatus", () => ({
  useBranchPullRequestStatus: () => ({
    ...mocks.status,
    refresh: mocks.refresh,
  }),
}));

vi.mock("../StatusBarTooltip", () => ({
  StatusBarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CiStatusMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.status.refreshing = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function renderMenu() {
    await act(async () => {
      root.render(
        React.createElement(CiStatusMenu, {
          branchName: "feature",
          headRevision: "abc",
        })
      );
    });
  }

  it("renders refresh and the last successful fetch time in the footer", async () => {
    await renderMenu();

    const refreshButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="ci-menu-refresh"]'
    );
    const footer = refreshButton?.parentElement;
    const fetchedAt = footer?.querySelector<HTMLElement>(
      '[title="workstation.ci.lastFetchedAt"]'
    );

    expect(refreshButton).not.toBeNull();
    expect(refreshButton?.textContent).toContain("workstation.ci.refresh");
    expect(footer?.className).toBe(STATUS_BAR_TOKENS.menuFooterClass);
    expect(footer?.className).toContain("pr-2");
    expect(fetchedAt?.textContent).toBe("07:54 AM");

    act(() => refreshButton?.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("disables the footer action and hides the stale clock while refreshing", async () => {
    mocks.status.refreshing = true;
    await renderMenu();

    const refreshButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="ci-menu-refresh"]'
    );

    expect(refreshButton?.disabled).toBe(true);
    expect(refreshButton?.textContent).toContain("workstation.ci.refreshing");
    expect(
      document.querySelector('[title="workstation.ci.lastFetchedAt"]')
    ).toBeNull();
  });
});
