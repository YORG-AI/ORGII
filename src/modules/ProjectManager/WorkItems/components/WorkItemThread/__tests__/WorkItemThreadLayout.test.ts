// @vitest-environment jsdom
import { type ComponentProps, type ReactNode, act, createElement } from "react";
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

import {
  WorkItemThreadLayout,
  WorkItemThreadNavigationPortalContext,
} from "..";

const { renderScrollTrail } = vi.hoisted(() => ({
  renderScrollTrail: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  DetailPanelContainer: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  ScrollTrail: (props: unknown) => {
    renderScrollTrail(props);
    return null;
  },
  WORKSTATION_TRAIL_RAIL_PADDING_CLASS: "px-1 pb-1 pt-2",
  WORKSTATION_TRAIL_WIDTH: { expandedPx: 256 },
}));

describe("WorkItemThreadLayout floating footer", () => {
  let container: HTMLDivElement;
  let root: Root;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    renderScrollTrail.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = observe;
        disconnect = disconnect;
      }
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("reserves the footer inset and disposes its observer on unmount", () => {
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const props: ComponentProps<typeof WorkItemThreadLayout> = {
      floatingFooter: createElement("div", null, "Composer"),
      children: createElement("div", null, "Timeline"),
    };

    act(() => {
      root.render(createElement(WorkItemThreadLayout, props));
    });

    const footer = container.querySelector(
      '[data-testid="work-item-thread-floating-footer"]'
    );
    const content = container.querySelector(
      '[data-testid="work-item-thread-section"] > div'
    );
    expect(footer?.className).toContain("absolute");
    expect(footer?.className).toContain("bottom-0");
    expect(footer?.className).toContain("right-11");
    expect(footer?.className).toContain("pb-3");
    expect(content?.getAttribute("style")).toContain("padding-bottom: 240px");
    expect(observe).toHaveBeenCalledWith(footer);

    act(() => root.unmount());
    root = createRoot(container);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeWindowListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
  });

  it("moves the navigation rail beneath a supplied properties trail host", () => {
    const navigationTrailHost = document.createElement("div");
    document.body.appendChild(navigationTrailHost);
    const layoutProps: ComponentProps<typeof WorkItemThreadLayout> = {
      floatingFooter: createElement("div", null, "Composer"),
      children: createElement("div", null, "Timeline"),
    };

    act(() => {
      root.render(
        createElement(
          WorkItemThreadNavigationPortalContext.Provider,
          { value: navigationTrailHost },
          createElement(WorkItemThreadLayout, layoutProps)
        )
      );
    });

    const portaledRail = navigationTrailHost.querySelector(
      '[data-testid="work-item-thread-navigation-rail"]'
    );
    expect(portaledRail).not.toBeNull();
    expect(portaledRail?.className).toContain("h-full");
    expect(renderScrollTrail).toHaveBeenLastCalledWith(
      expect.objectContaining({ alignment: "start" })
    );
    expect(
      container.querySelector(
        '[data-testid="work-item-thread-navigation-rail"]'
      )
    ).toBeNull();
    const footer = container.querySelector(
      '[data-testid="work-item-thread-floating-footer"]'
    );
    expect(footer?.className).toContain("right-0");
    expect(footer?.className).not.toContain("right-11");

    navigationTrailHost.remove();
  });

  it("does not retain measurement resources without a floating footer", () => {
    const addWindowListener = vi.spyOn(window, "addEventListener");

    act(() => {
      root.render(
        createElement(
          WorkItemThreadLayout,
          null,
          createElement("div", null, "Timeline")
        )
      );
    });

    expect(observe).not.toHaveBeenCalled();
    expect(addWindowListener).not.toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
    expect(
      container.querySelector(
        '[data-testid="work-item-thread-floating-footer"]'
      )
    ).toBeNull();
  });

  it("hides the native scrollbar when the navigation guide is present", () => {
    act(() => {
      root.render(
        createElement(
          WorkItemThreadLayout,
          null,
          createElement("div", null, "Timeline")
        )
      );
    });

    const scrollSection = container.querySelector(
      '[data-testid="work-item-thread-section"]'
    );
    expect(scrollSection?.classList.contains("scrollbar-hide")).toBe(true);
    expect(scrollSection?.classList.contains("scrollbar-overlay")).toBe(false);
  });

  it("hosts the navigation trail inside its own details rail", () => {
    const props: ComponentProps<typeof WorkItemThreadLayout> = {
      sidebar: createElement("aside", { "data-testid": "rail-content" }),
      flowHeader: createElement("h2", { "data-testid": "flow-header" }),
      floatingFooter: createElement("div", null, "Composer"),
      children: createElement("div", null, "Timeline"),
    };

    act(() => {
      root.render(createElement(WorkItemThreadLayout, props));
    });

    const rail = container.querySelector<HTMLElement>(
      '[data-testid="work-item-thread-details-rail"]'
    );
    expect(rail).not.toBeNull();
    expect(rail?.style.width).toBe("256px");
    expect(rail?.querySelector('[data-testid="rail-content"]')).not.toBeNull();
    // One right-hand column: the trail sits under the rail content instead of
    // stacking a second rail beside it.
    const navigationRail = container.querySelector(
      '[data-testid="work-item-thread-navigation-rail"]'
    );
    expect(rail?.contains(navigationRail as Node)).toBe(true);

    // The flow header renders above the thread body, inside the scrollport.
    const scrollSection = container.querySelector(
      '[data-testid="work-item-thread-section"]'
    );
    expect(
      scrollSection?.querySelector('[data-testid="flow-header"]')
    ).not.toBeNull();

    // The docked composer clears the full rail rather than the 44px trail.
    const footer = container.querySelector(
      '[data-testid="work-item-thread-floating-footer"]'
    );
    expect(footer?.className).toContain("right-64");
    expect(footer?.className).not.toContain("right-11");
  });

  it("keeps a standalone navigation rail when no details rail is supplied", () => {
    const props: ComponentProps<typeof WorkItemThreadLayout> = {
      floatingFooter: createElement("div", null, "Composer"),
      children: createElement("div", null, "Timeline"),
    };

    act(() => {
      root.render(createElement(WorkItemThreadLayout, props));
    });

    expect(
      container.querySelector('[data-testid="work-item-thread-details-rail"]')
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="work-item-thread-floating-footer"]'
      )?.className
    ).toContain("right-11");
  });
});
