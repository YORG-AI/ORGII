// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
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

import { REPO_KIND } from "@src/store/repo";

import { WorkspaceDropdown } from "./WorkspaceDropdown";

const EXTERNAL_RECENT_PATH = "/Users/tester/Documents/GitHub/business-plan";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/api/tauri/repo", () => ({
  repoApi: { getRepoById: vi.fn() },
}));

vi.mock("@src/scaffold/GlobalSpotlight/hooks", () => ({
  EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD: 5,
  useSharedRepoList: () => ({
    repos: [],
    filteredRepos: [],
    repoLoading: false,
    refreshReposForce: vi.fn(),
  }),
  useExternalRecentPaths: () => ({
    recentPathRepos: [
      {
        id: `external-recent:${EXTERNAL_RECENT_PATH}`,
        name: "business-plan",
        description: EXTERNAL_RECENT_PATH,
        fs_uri: EXTERNAL_RECENT_PATH,
        kind: REPO_KIND.FOLDER,
      },
    ],
  }),
  useWorkspaceSwitch: () => ({
    workspaces: [],
    activateWorkspace: vi.fn(),
  }),
}));

vi.mock("@src/scaffold/GlobalSpotlight/hooks/forms", () => ({
  useWorkspaceForm: () => ({ handleImportWorkspace: vi.fn() }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    isPositioned: true,
    panelRef: createRef<HTMLDivElement>(),
    panelPosition: { top: 100, bottom: undefined, left: 40, width: 320 },
    keyboard: {
      selectedIndex: -1,
      setSelectedIndex: vi.fn(),
      getItemProps: (index: number) => ({
        "data-dropdown-item-index": index,
        "aria-selected": false,
        onMouseEnter: vi.fn(),
        onClick: vi.fn(),
      }),
      handleKeyDown: vi.fn(),
      keyboardNavigated: false,
      clearKeyboardNavigation: vi.fn(),
    },
  }),
}));

describe("WorkspaceDropdown rows", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const renderDropdown = () => {
    act(() => {
      root.render(
        createElement(WorkspaceDropdown, {
          isOpen: true,
          onClose: vi.fn(),
          onSelect: vi.fn(),
          anchorRef: createRef<HTMLElement>(),
        })
      );
    });
  };

  const externalRecentRow = () =>
    document.querySelector<HTMLButtonElement>(
      `[data-testid="repo-dropdown-row-external-recent:${EXTERNAL_RECENT_PATH}"]`
    );

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
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

  it("keeps the path off the row instead of rendering it as a second line", () => {
    renderDropdown();

    const row = externalRecentRow();
    expect(row).not.toBeNull();
    expect(row?.textContent).toBe("business-plan");
    expect(row?.textContent).not.toContain(EXTERNAL_RECENT_PATH);
  });

  it("reveals the path in a tooltip while the row is hovered", () => {
    renderDropdown();

    const row = externalRecentRow();
    expect(document.querySelector(".native-tooltip")).toBeNull();

    act(() => {
      row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(500);
    });

    expect(document.querySelector(".native-tooltip")?.textContent).toBe(
      EXTERNAL_RECENT_PATH
    );

    act(() => {
      row?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      vi.advanceTimersByTime(500);
    });

    expect(document.querySelector(".native-tooltip")).toBeNull();
  });

  it("marks the panel as a menu so side tooltips clear its border", () => {
    renderDropdown();

    const panel = document.querySelector('[role="menu"]');
    expect(panel).not.toBeNull();
    expect(externalRecentRow()?.closest('[role="menu"]')).toBe(panel);
  });
});
