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

import { SessionFilterButton } from "../SessionFilterButton";

const mocks = vi.hoisted(() => ({
  closeDropdown: vi.fn(),
  toggleDropdown: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    isOpen: true,
    isPositioned: true,
    toggle: mocks.toggleDropdown,
    close: mocks.closeDropdown,
    triggerRef: { current: null },
    panelRef: { current: null },
    // Sidebar bottom bar: the panel grows upward from the button.
    panelPosition: { bottom: 48, left: 12, width: 180 },
  }),
}));

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function queryTestId(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

describe("SessionFilterButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;
  let onSelectGroupVisibleCount: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    onSelect = vi.fn();
    onSelectGroupVisibleCount = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(SessionFilterButton, {
          groupByMode: "byTime",
          groupVisibleCount: 10,
          includeExternal: true,
          onSelect,
          onSelectGroupVisibleCount,
          onToggleIncludeExternal: vi.fn(),
          onRefreshSessions: vi.fn(),
          onCollapseAll: vi.fn(),
          onMarkAllRead: vi.fn(),
          onConfigureExternalSources: vi.fn(),
        })
      );
    });
  });

  it("exposes separate sort modes and persists manual selection", async () => {
    await act(async () => queryTestId("sidebar-sort-trigger")?.click());
    expect(queryTestId("sidebar-sort-priority")).not.toBeNull();
    expect(queryTestId("sidebar-sort-updated")).not.toBeNull();
    await act(async () => queryTestId("sidebar-sort-manual")?.click());
    expect(localStorage.getItem("orgii:sidebarSessionSort")).toBe('"manual"');
    expect(mocks.closeDropdown).toHaveBeenCalled();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the grouping modes one level down and names the active one", () => {
    const trigger = queryTestId("sidebar-group-by-trigger");

    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("sidebar.groupBy.title");
    expect(trigger?.textContent).toContain("sidebar.groupBy.byTime");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    const showTrigger = queryTestId("sidebar-show-trigger");
    expect(showTrigger?.textContent).toContain("sidebar.show.title");
    expect(showTrigger?.textContent).toContain("sidebar.show.recent10");
    expect(showTrigger?.getAttribute("aria-expanded")).toBe("false");

    // The first level keeps only the actions; no mode is selectable yet.
    expect(queryTestId("sidebar-group-by-byTime")).toBeNull();
    expect(queryTestId("sidebar-group-by-byWorkspace")).toBeNull();
    expect(queryTestId("sidebar-group-by-byAgent")).toBeNull();
    expect(queryTestId("sidebar-refresh-sessions")).not.toBeNull();
  });

  it("uses the sidebar row corner radius instead of a circular trigger", () => {
    const trigger = queryTestId("sidebar-session-filter-button");

    expect(trigger?.className).toContain("rounded-lg!");
    expect(trigger?.className).not.toContain("rounded-full");
  });

  it("gives Include External a leading icon like every other action row", () => {
    const includeExternal = queryTestId("sidebar-include-external");

    expect(
      includeExternal?.querySelector('[data-icon="folder-symlink"]')
    ).not.toBeNull();
    // Selected, so the trailing check still marks the state the icon labels.
    expect(includeExternal?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the icon-free second level with the active mode checked", async () => {
    await act(async () => {
      queryTestId("sidebar-group-by-trigger")?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    expect(queryTestId("sidebar-group-by-submenu")).not.toBeNull();
    expect(
      queryTestId("sidebar-group-by-trigger")?.getAttribute("aria-expanded")
    ).toBe("true");
    expect(
      queryTestId("sidebar-group-by-byTime")?.getAttribute("aria-selected")
    ).toBe("true");
    expect(
      queryTestId("sidebar-group-by-byWorkspace")?.getAttribute("aria-selected")
    ).toBe("false");
    expect(
      queryTestId("sidebar-group-by-submenu")?.querySelector(
        '[data-icon="clock"], [data-icon="folder-open"], [data-icon="infinity"]'
      )
    ).toBeNull();
  });

  it("opens the second level on click, for pointerless interaction", async () => {
    await act(async () => {
      queryTestId("sidebar-group-by-trigger")?.click();
    });

    expect(queryTestId("sidebar-group-by-submenu")).not.toBeNull();

    await act(async () => {
      queryTestId("sidebar-group-by-trigger")?.click();
    });

    expect(queryTestId("sidebar-group-by-submenu")).toBeNull();
  });

  it("selects a mode from the second level and closes the whole menu", async () => {
    await act(async () => {
      queryTestId("sidebar-group-by-trigger")?.click();
    });
    await act(async () => {
      queryTestId("sidebar-group-by-byWorkspace")?.click();
    });

    expect(onSelect).toHaveBeenCalledWith("byWorkspace");
    expect(mocks.closeDropdown).toHaveBeenCalledTimes(1);
    expect(queryTestId("sidebar-group-by-submenu")).toBeNull();
  });

  it("selects how many recent sessions each group shows", async () => {
    await act(async () => {
      queryTestId("sidebar-show-trigger")?.click();
    });

    expect(queryTestId("sidebar-show-submenu")).not.toBeNull();
    expect(
      queryTestId("sidebar-show-recent-10")?.getAttribute("aria-selected")
    ).toBe("true");
    expect(
      queryTestId("sidebar-show-recent-5")?.getAttribute("aria-selected")
    ).toBe("false");
    expect(
      queryTestId("sidebar-show-submenu")?.querySelector('[data-icon="clock"]')
    ).toBeNull();

    await act(async () => {
      queryTestId("sidebar-show-recent-5")?.click();
    });

    expect(onSelectGroupVisibleCount).toHaveBeenCalledWith(5);
    expect(mocks.closeDropdown).toHaveBeenCalledTimes(1);
    expect(queryTestId("sidebar-show-submenu")).toBeNull();
  });

  it("switches directly between the two setting submenus", async () => {
    await act(async () => {
      queryTestId("sidebar-group-by-trigger")?.click();
    });
    expect(queryTestId("sidebar-group-by-submenu")).not.toBeNull();

    await act(async () => {
      queryTestId("sidebar-show-trigger")?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    expect(queryTestId("sidebar-group-by-submenu")).toBeNull();
    expect(queryTestId("sidebar-show-submenu")).not.toBeNull();
  });

  it("dismisses the second level when the pointer moves to another row", async () => {
    await act(async () => {
      queryTestId("sidebar-group-by-trigger")?.click();
    });
    expect(queryTestId("sidebar-group-by-submenu")).not.toBeNull();

    await act(async () => {
      queryTestId("sidebar-refresh-sessions")?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    expect(queryTestId("sidebar-group-by-submenu")).toBeNull();
  });
});
