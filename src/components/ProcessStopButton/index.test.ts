// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProcessStopButton } from ".";

describe("process stop control", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("stops a process without also opening its containing row", () => {
    const open = vi.fn();
    const stop = vi.fn();
    act(() =>
      root.render(
        React.createElement(
          "div",
          { onClick: open },
          React.createElement(ProcessStopButton, {
            label: "Stop process",
            onClick: stop,
          })
        )
      )
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Stop process");
    expect(button.querySelector('[data-icon="stop"]')).not.toBeNull();
    act(() => button.click());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([{ loading: true }, { disabled: true }])(
    "prevents another stop while unavailable: %o",
    (state) => {
      const stop = vi.fn();
      act(() =>
        root.render(
          React.createElement(ProcessStopButton, {
            label: "Stop process",
            onClick: stop,
            ...state,
          })
        )
      );
      const button = container.querySelector("button")!;
      expect(button.disabled).toBe(true);
      act(() => button.click());
      expect(stop).not.toHaveBeenCalled();
    }
  );
});
