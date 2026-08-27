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

import SidebarGuideButton from "../SidebarGuideButton";
import { SIDEBAR_GUIDE_MILESTONE } from "../sidebarGuideProgress";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  engineOptions: vi.fn(),
  isPositioned: true,
  setIsOpen: vi.fn(),
  toggle: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: (options: unknown) => {
    mocks.engineOptions(options);
    return {
      isOpen: true,
      isPositioned: mocks.isPositioned,
      setIsOpen: mocks.setIsOpen,
      toggle: mocks.toggle,
      close: mocks.close,
      triggerRef: { current: null },
      panelRef: { current: null },
      panelPosition: { bottom: 48, left: 8, right: 12 },
    };
  },
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SidebarGuideButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStartSession = vi.fn();
  const onAutoOpenConsumed = vi.fn();
  const onConnectOrganization = vi.fn();
  const onInviteTeammate = vi.fn();
  const onViewTeamUsage = vi.fn();
  const onExploreProduct = vi.fn();
  const onOpenQuickSetup = vi.fn();

  const renderButton = async (
    overrides: Partial<React.ComponentProps<typeof SidebarGuideButton>> = {}
  ) => {
    await act(async () => {
      root.render(
        React.createElement(SidebarGuideButton, {
          completion: {
            [SIDEBAR_GUIDE_MILESTONE.SESSION]: true,
            [SIDEBAR_GUIDE_MILESTONE.ORGANIZATION]: false,
            [SIDEBAR_GUIDE_MILESTONE.TEAMMATE]: false,
            [SIDEBAR_GUIDE_MILESTONE.TEAM_USAGE]: false,
            [SIDEBAR_GUIDE_MILESTONE.PRODUCT_TOUR]: false,
          },
          scopeLabel: "ORG2 OSS",
          autoOpenRequested: false,
          onAutoOpenConsumed,
          onStartSession,
          onConnectOrganization,
          onInviteTeammate,
          onViewTeamUsage,
          onExploreProduct,
          onOpenQuickSetup,
          ...overrides,
        })
      );
    });
  };

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    mocks.isPositioned = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await renderButton();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("configures the persistent bottom-bar guide to be closed by default", () => {
    expect(mocks.engineOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultOpen: false,
        placement: "top",
        align: "right",
      })
    );
    expect(
      document.querySelector('[data-testid="sidebar-guide-trigger"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="sidebar-guide-panel"]')
    ).not.toBeNull();

    const panel = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-guide-panel"]'
    );
    expect(panel?.style.bottom).toBe("48px");
    expect(panel?.style.right).toBe("12px");
    expect(panel?.style.left).toBe("");

    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).map((item) => item.children.item(1)?.textContent);
    expect(labels).toEqual([
      "sidebar.guide.startSession",
      "sidebar.guide.connectOrganization",
      "sidebar.guide.inviteTeammate",
      "sidebar.guide.viewTeamActivity",
      "sidebar.guide.exploreProduct",
    ]);
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow")
    ).toBe("20");
    expect(document.body.textContent).toContain("ORG2 OSS");
  });

  it("labels only the first incomplete milestone as the next step", () => {
    const nextStepRows = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).filter((item) => item.textContent?.includes("sidebar.guide.nextStep"));

    expect(nextStepRows).toHaveLength(1);
    expect(nextStepRows[0]?.dataset.testid).toBe(
      "sidebar-guide-task-organization"
    );
    expect(nextStepRows[0]?.className).toContain("bg-primary-6/5");
    expect(nextStepRows[0]?.className).not.toContain("bg-fill-2");
  });

  it("mounts the panel invisibly until its measured position is ready", async () => {
    mocks.isPositioned = false;
    await renderButton();

    const measuringPanel = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-guide-panel"]'
    );
    expect(measuringPanel).not.toBeNull();
    expect(measuringPanel?.style.visibility).toBe("hidden");
    expect(measuringPanel?.style.pointerEvents).toBe("none");
    expect(measuringPanel?.getAttribute("aria-hidden")).toBe("true");

    mocks.isPositioned = true;
    await renderButton();

    const positionedPanel = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-guide-panel"]'
    );
    expect(positionedPanel?.style.visibility).toBe("");
    expect(positionedPanel?.style.pointerEvents).toBe("");
    expect(positionedPanel?.getAttribute("aria-hidden")).toBe("false");
  });

  it.each([
    ["sidebar.guide.startSession", onStartSession],
    ["sidebar.guide.connectOrganization", onConnectOrganization],
    ["sidebar.guide.inviteTeammate", onInviteTeammate],
    ["sidebar.guide.viewTeamActivity", onViewTeamUsage],
    ["sidebar.guide.exploreProduct", onExploreProduct],
  ])("closes before running %s", (label, action) => {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((candidate) => candidate.textContent?.startsWith(label));

    expect(item).toBeDefined();
    act(() => item?.click());

    expect(mocks.close).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      action.mock.invocationCallOrder[0]
    );
  });

  it("opens quick setup from the panel header and closes first", () => {
    const quickSetupButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="sidebar.guide.quickSetup"]'
    );

    expect(quickSetupButton).not.toBeNull();
    act(() => quickSetupButton?.click());

    expect(mocks.close).toHaveBeenCalledOnce();
    expect(onOpenQuickSetup).toHaveBeenCalledOnce();
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenQuickSetup.mock.invocationCallOrder[0]
    );
  });

  it("uses a downward collapse icon for the upward-opening panel", () => {
    const collapseButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="sidebar.guide.close"]'
    );

    expect(collapseButton).not.toBeNull();
    expect(
      collapseButton?.querySelector(".lucide-chevron-down")
    ).not.toBeNull();
    act(() => collapseButton?.click());

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not request auto-open after the one-time handoff was consumed", () => {
    expect(mocks.setIsOpen).not.toHaveBeenCalled();
    expect(onAutoOpenConsumed).not.toHaveBeenCalled();
  });

  it("removes the guide once every milestone is complete", async () => {
    await renderButton({
      completion: {
        [SIDEBAR_GUIDE_MILESTONE.SESSION]: true,
        [SIDEBAR_GUIDE_MILESTONE.ORGANIZATION]: true,
        [SIDEBAR_GUIDE_MILESTONE.TEAMMATE]: true,
        [SIDEBAR_GUIDE_MILESTONE.TEAM_USAGE]: true,
        [SIDEBAR_GUIDE_MILESTONE.PRODUCT_TOUR]: true,
      },
      autoOpenRequested: true,
    });

    expect(
      document.querySelector('[data-testid="sidebar-guide-trigger"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="sidebar-guide-panel"]')
    ).toBeNull();
    expect(mocks.setIsOpen).not.toHaveBeenCalled();
    expect(onAutoOpenConsumed).not.toHaveBeenCalled();
  });

  it("consumes a pending handoff after requesting the panel to open", async () => {
    await renderButton({ autoOpenRequested: true });

    expect(mocks.setIsOpen).toHaveBeenCalledWith(true);
    expect(onAutoOpenConsumed).toHaveBeenCalledOnce();
  });
});
