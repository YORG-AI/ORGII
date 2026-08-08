// @vitest-environment jsdom
import { act, createElement } from "react";
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

import { WorkstationSidebarViewSwitcher } from "./WorkstationSidebarViewSwitcher";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "routes.channels": "Channels",
        "labels.workItems": "Work Items",
        "routes.sessions": "Sessions",
        "sidebar.tabs.workstation": "Workstation",
      })[key] ?? key,
  }),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({
    children,
    mouseEnterDelay,
  }: {
    children: React.ReactNode;
    mouseEnterDelay?: number;
  }) =>
    createElement(
      "span",
      { "data-tooltip-enter-delay": mouseEnterDelay },
      children
    ),
}));

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("WorkstationSidebarViewSwitcher", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("exposes three labeled destinations and marks the active view", () => {
    act(() => {
      root.render(
        createElement(WorkstationSidebarViewSwitcher, {
          activeKey: "sessions",
          onChange: () => undefined,
        })
      );
    });

    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Workstation"
    );
    expect(container.querySelector("nav")?.classList.contains("pt-1")).toBe(
      true
    );
    expect(
      container.querySelector('[data-testid="sidebar-view-channels"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-view-work-items"]')
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="sidebar-view-work-items"]')
        ?.classList.contains("h-7")
    ).toBe(true);
    expect(
      container
        .querySelector('[data-testid="sidebar-view-work-items"]')
        ?.classList.contains("rounded-full")
    ).toBe(true);
    expect(
      container
        .querySelector('[data-testid="sidebar-view-sessions"]')
        ?.getAttribute("aria-current")
    ).toBe("page");
    const selection = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-view-selection"]'
    );
    expect(selection?.classList.contains("bg-chat-pane/70")).toBe(true);
    expect(selection?.classList.contains("duration-150")).toBe(true);
    expect(selection?.classList.contains("motion-reduce:transition-none")).toBe(
      true
    );
    expect(selection?.style.transform).toBe("translateX(calc(100% + 0.25rem))");
    expect(
      container
        .querySelector('[data-testid="sidebar-view-channels"]')
        ?.classList.contains("hover:bg-sidebar-selected")
    ).toBe(true);
    expect(container.querySelector("[title]")).toBeNull();
    expect(
      Array.from(
        container.querySelectorAll('[data-tooltip-enter-delay="1500"]')
      )
    ).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll("button")).map((button) =>
        button.getAttribute("data-testid")
      )
    ).toEqual([
      "sidebar-view-work-items",
      "sidebar-view-sessions",
      "sidebar-view-channels",
    ]);

    act(() => {
      root.render(
        createElement(WorkstationSidebarViewSwitcher, {
          activeKey: "channels",
          onChange: () => undefined,
        })
      );
    });

    expect(selection?.style.transform).toBe("translateX(calc(200% + 0.5rem))");
    expect(
      container
        .querySelector('[data-testid="sidebar-view-channels"]')
        ?.getAttribute("aria-current")
    ).toBe("page");
  });

  it("dispatches destination changes", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(WorkstationSidebarViewSwitcher, {
          activeKey: "sessions",
          onChange,
        })
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-view-channels"]'
        )
        ?.click();
    });
    expect(onChange).toHaveBeenCalledWith("channels");
  });
});
