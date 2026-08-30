// @vitest-environment jsdom
import { type ComponentProps, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";

import Tooltip from ".";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Tooltip menu spacing", () => {
  function renderPositionedTooltip({
    position = "left",
    inset = 5,
    inMenu = true,
    panelStyle = false,
    style,
  }: {
    position?: ComponentProps<typeof Tooltip>["position"];
    inset?: number;
    inMenu?: boolean;
    panelStyle?: boolean;
    style?: ComponentProps<typeof Tooltip>["style"];
  } = {}) {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const isMenu = this.getAttribute("role") === "menu";
        const isTooltip = this.classList.contains("native-tooltip");
        // Simulate the tooltip's opening scale (0.95), while layout remains 200×40.
        const left = isMenu ? 400 : 400 + inset;
        const top = isMenu ? 100 : 220;
        const width = isTooltip ? 190 : isMenu ? 180 : 180 - 2 * inset;
        const height = isTooltip ? 38 : isMenu ? 400 : 32;
        return {
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
          x: left,
          y: top,
          toJSON: () => ({}),
        };
      }
    );
    act(() =>
      root.render(
        createElement(
          "div",
          { role: inMenu ? "menu" : undefined },
          createElement(
            Tooltip,
            {
              content: "Details",
              open: true,
              position,
              panelStyle,
              style,
            } as ComponentProps<typeof Tooltip>,
            createElement("button", null, "Trigger")
          )
        )
      )
    );
    act(() => vi.advanceTimersByTime(32));
    return document.querySelector<HTMLElement>(".native-tooltip")!;
  }

  it.each([0, 5, 12])(
    "measures a left tooltip from the outer menu with a %ipx row inset",
    (inset) => {
      const tooltip = renderPositionedTooltip({ inset });
      expect(tooltip.style.left).toBe(
        `${400 - 200 - DROPDOWN_PANEL.submenuGap}px`
      );
      expect(tooltip.style.top).toBe("216px");
    }
  );

  it("uses the same gap on the right side", () => {
    const tooltip = renderPositionedTooltip({ position: "right", inset: 12 });
    expect(tooltip.style.left).toBe(`${580 + DROPDOWN_PANEL.submenuGap}px`);
  });

  it("uses unscaled fractional border-box dimensions when available", () => {
    const tooltip = renderPositionedTooltip({
      style: { width: 200.25, height: 40.5 },
    });
    expect(tooltip.style.left).toBe(
      `${400 - 200.25 - DROPDOWN_PANEL.submenuGap}px`
    );
    expect(tooltip.style.top).toBe("215.75px");
  });

  it("uses the same gap from the trigger outside a menu", () => {
    const tooltip = renderPositionedTooltip({ inMenu: false, inset: 12 });
    expect(tooltip.style.left).toBe(
      `${412 - 200 - DROPDOWN_PANEL.submenuGap}px`
    );
  });

  it("uses the same surface gap for non-framed tooltips", () => {
    const tooltip = renderPositionedTooltip({ panelStyle: true, inset: 12 });
    expect(tooltip.style.left).toBe(
      `${412 - 200 - DROPDOWN_PANEL.submenuGap}px`
    );
  });

  it("keeps top tooltips attached to the row", () => {
    const tooltip = renderPositionedTooltip({ position: "top" });
    expect(tooltip.style.top).toBe(`${220 - 40 - DROPDOWN_PANEL.submenuGap}px`);
  });
});

describe("Tooltip child refs", () => {
  it("hands changing callback refs to React without render-driven state churn", () => {
    const firstRef = vi.fn();
    const secondRef = vi.fn();
    const render = (childRef: (node: HTMLButtonElement | null) => void) =>
      createElement(
        Tooltip,
        { content: "Details" } as ComponentProps<typeof Tooltip>,
        createElement("button", { ref: childRef }, "Trigger")
      );

    act(() => root.render(render(firstRef)));
    const button = container.querySelector("button");
    expect(firstRef).toHaveBeenLastCalledWith(button);

    act(() => root.render(render(secondRef)));
    expect(firstRef).toHaveBeenLastCalledWith(null);
    expect(secondRef).toHaveBeenLastCalledWith(button);

    for (let index = 0; index < 20; index += 1) {
      act(() => root.render(render(vi.fn())));
    }
    expect(container.querySelector("button")).toBe(button);
  });
});

describe("Tooltip open state", () => {
  it("supports the defaultOpen uncontrolled contract", () => {
    act(() => {
      root.render(
        createElement(
          Tooltip,
          { content: "Details", defaultOpen: true } as ComponentProps<
            typeof Tooltip
          >,
          createElement("button", null, "Trigger")
        )
      );
    });

    expect(
      document.body.querySelector(".native-tooltip-content-inner")?.textContent
    ).toBe("Details");
  });

  it("reports click-triggered changes without mutating controlled state", async () => {
    const onOpenChange = vi.fn();
    const render = (open: boolean) =>
      createElement(
        Tooltip,
        {
          content: "Details",
          trigger: "click",
          open,
          onOpenChange,
          mouseEnterDelay: 0,
          mouseLeaveDelay: 0,
        } as unknown as ComponentProps<typeof Tooltip>,
        createElement("button", null, "Trigger")
      );

    act(() => root.render(render(false)));
    const button = container.querySelector("button");

    await act(async () => {
      button?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(document.body.querySelector(".native-tooltip")).toBeNull();

    act(() => root.render(render(true)));
    expect(document.body.querySelector(".native-tooltip")).not.toBeNull();

    await act(async () => {
      button?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.body.querySelector(".native-tooltip")).not.toBeNull();
  });
});
