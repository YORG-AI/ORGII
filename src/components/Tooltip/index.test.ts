// @vitest-environment jsdom
import { type ComponentProps, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
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
