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

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  toggle: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    isOpen: true,
    isPositioned: true,
    toggle: mocks.toggle,
    close: mocks.close,
    triggerRef: { current: null },
    panelRef: { current: null },
    panelPosition: { top: 32, left: 8 },
  }),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  WorkstationToolbarTooltip: ({ children }: { children: React.ReactNode }) =>
    children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SidebarGuideButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStartSession = vi.fn();
  const onSetUpTeam = vi.fn();
  const onManageWork = vi.fn();
  const onOpenTutorials = vi.fn();

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(SidebarGuideButton, {
          onStartSession,
          onSetUpTeam,
          onManageWork,
          onOpenTutorials,
        })
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders a persistent top-bar trigger and the four guide actions", () => {
    expect(
      document.querySelector('[data-testid="sidebar-guide-trigger"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="sidebar-guide-panel"]')
    ).not.toBeNull();

    const labels = Array.from(
      document.querySelectorAll('[role="menuitem"]')
    ).map((item) => item.textContent);
    expect(labels).toEqual([
      "sidebar.guide.startSession",
      "sidebar.guide.setUpTeam",
      "sidebar.guide.manageWork",
      "sidebar.guide.openTutorials",
    ]);
  });

  it.each([
    ["sidebar.guide.startSession", onStartSession],
    ["sidebar.guide.setUpTeam", onSetUpTeam],
    ["sidebar.guide.manageWork", onManageWork],
    ["sidebar.guide.openTutorials", onOpenTutorials],
  ])("closes before running %s", (label, action) => {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((candidate) => candidate.textContent === label);

    expect(item).toBeDefined();
    act(() => item?.click());

    expect(mocks.close).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      action.mock.invocationCallOrder[0]
    );
  });
});
