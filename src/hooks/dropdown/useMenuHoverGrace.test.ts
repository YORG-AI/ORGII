// @vitest-environment jsdom
import React, { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMenuHoverGrace } from "./useMenuHoverGrace";

describe("useMenuHoverGrace lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let hover: ReturnType<typeof useMenuHoverGrace>;
  let unmounted: boolean;

  function Harness({
    enabled,
    delayMs,
  }: {
    enabled: boolean;
    delayMs?: number;
  }) {
    const value = useMenuHoverGrace(enabled, delayMs);
    useEffect(() => {
      hover = value;
    }, [value]);
    return null;
  }
  function render(enabled = true, delayMs?: number) {
    act(() => root.render(React.createElement(Harness, { enabled, delayMs })));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    root = createRoot(container);
    unmounted = false;
    render();
  });

  afterEach(() => {
    if (!unmounted) act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("retains only the latest transition and leaves no timer or listener afterward", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    hover.schedule(first);
    vi.advanceTimersByTime(100);
    hover.schedule(latest);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(300);
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(latest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    for (const [type, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(type, listener);
    }
  });

  it.each(["cancel", "disable", "unmount", "hide"])(
    "discards pending work on %s, including after focus return",
    (reason) => {
      const transition = vi.fn();
      const remove = vi.spyOn(document, "removeEventListener");
      hover.schedule(transition);
      if (reason === "cancel") hover.cancel();
      if (reason === "disable") render(false);
      if (reason === "unmount") {
        act(() => root.unmount());
        unmounted = true;
      }
      if (reason === "hide") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      }
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function)
      );
      vi.restoreAllMocks();
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(1000);
      expect(transition).not.toHaveBeenCalled();
    }
  );

  it("creates no background work while disabled, hidden, or idle", () => {
    const transition = vi.fn();
    const add = vi.spyOn(document, "addEventListener");
    render(false);
    hover.schedule(transition);
    render(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    hover.schedule(transition);
    vi.advanceTimersByTime(1000);
    expect(transition).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });

  it("preserves explicit immediate-close behavior without a timer", () => {
    render(true, 0);
    const transition = vi.fn();
    hover.schedule(transition);
    expect(transition).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up across repeated open/close cycles", () => {
    const transition = vi.fn();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      render(true);
      hover.schedule(transition);
      hover.schedule(transition);
      expect(vi.getTimerCount()).toBe(1);
      render(false);
      expect(vi.getTimerCount()).toBe(0);
    }
    vi.advanceTimersByTime(1000);
    expect(transition).not.toHaveBeenCalled();
  });
});
