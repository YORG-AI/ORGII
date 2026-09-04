// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrailPanelResizeHandle } from "./TrailPanelResizeHandle";

describe("trail panel corner resize", () => {
  let root: Root;
  let container: HTMLDivElement;
  let panel: HTMLDivElement;
  let button: HTMLButtonElement;
  let width: number;
  let height: number;
  let scale: number;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const onResize = vi.fn();
  const onResizeEnd = vi.fn();
  const onResizingChange = vi.fn();

  function pointer(
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    pointerId = 1,
    mouseButton = 0
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: mouseButton,
    });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      isPrimary: { value: true },
    });
    act(() => target.dispatchEvent(event));
  }
  function flushFrame() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    width = 400;
    height = 260;
    scale = 1;
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      })
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => frames.delete(id))
    );
    onResize.mockReset().mockImplementation((size) => {
      width = size.width;
      height = size.height;
    });
    onResizeEnd.mockReset();
    onResizingChange.mockReset();
    container = document.createElement("div");
    panel = document.createElement("div");
    panel.dataset.workstationTrailPanel = "";
    container.appendChild(panel);
    document.body.appendChild(container);
    Object.defineProperties(panel, {
      offsetWidth: { get: () => width },
      offsetHeight: { get: () => height },
    });
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(() => ({
      left: 800 - width * scale,
      right: 800,
      top: 100,
      bottom: 100 + height * scale,
      width: width * scale,
      height: height * scale,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    }));
    root = createRoot(panel);
    act(() =>
      root.render(
        React.createElement(TrailPanelResizeHandle, {
          label: "Resize panel",
          min: { width: 220, height: 80 },
          max: { width: 720, height: 720 },
          onResize,
          onResizeEnd,
          onResizingChange,
        })
      )
    );
    button = panel.querySelector("button")!;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("does no scheduled work before a drag and ignores right click", () => {
    const add = vi.spyOn(window, "addEventListener");
    pointer(button, "pointerdown", 400, 360, 1, 2);
    expect(add).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(onResizingChange).not.toHaveBeenCalled();
  });

  it("grows left/down at UI scale and coalesces pointer bursts into one frame", () => {
    scale = 2;
    pointer(button, "pointerdown", 0, 620);
    for (let index = 1; index <= 60; index++) {
      pointer(window, "pointermove", -index * 2, 620 + index);
    }
    expect(frames.size).toBe(1);
    expect(onResize).not.toHaveBeenCalled();
    flushFrame();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith({ width: 460, height: 290 });
    expect(onResizeEnd).not.toHaveBeenCalled();
    pointer(window, "pointerup", -120, 680);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenLastCalledWith({
      width: 460,
      height: 290,
    });
    expect(frames.size).toBe(0);
  });

  it("flushes the final pointer position before committing, without waiting for RAF", () => {
    pointer(button, "pointerdown", 400, 360);
    pointer(window, "pointermove", 390, 370);
    pointer(window, "pointerup", 330, 430);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenLastCalledWith({
      width: 470,
      height: 330,
    });
    expect(frames.size).toBe(0);
  });

  it("clamps both dimensions while shrinking", () => {
    pointer(button, "pointerdown", 400, 360);
    pointer(window, "pointerup", 1400, -100);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenLastCalledWith({
      width: 220,
      height: 80,
    });
  });

  it("uses a release back at the starting point instead of retaining a stale move", () => {
    pointer(button, "pointerdown", 400, 360);
    pointer(window, "pointermove", 350, 410);
    flushFrame();
    pointer(window, "pointerup", 400, 360);
    expect(onResizeEnd).toHaveBeenLastCalledWith({ width: 400, height: 260 });
  });

  it("leaves room for the panel below and the track padding", () => {
    container.dataset.workstationTrailTrack = "";
    container.style.paddingBottom = "4px";
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
    } as DOMRect);
    const sibling = document.createElement("div");
    sibling.style.marginTop = "4px";
    vi.spyOn(sibling, "getBoundingClientRect").mockReturnValue({
      height: 150,
    } as DOMRect);
    container.appendChild(sibling);
    pointer(button, "pointerdown", 400, 360);
    pointer(window, "pointerup", 350, 1500);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenLastCalledWith({
      width: 450,
      height: 342,
    });
  });

  it("ignores other pointers during the active drag", () => {
    pointer(button, "pointerdown", 400, 360);
    pointer(window, "pointermove", 0, 0, 2);
    pointer(window, "pointercancel", 0, 0, 2);
    pointer(window, "pointerup", 0, 0, 2);
    expect(onResizeEnd).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("nesw-resize");
    pointer(window, "pointerup", 390, 370);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenLastCalledWith({
      width: 410,
      height: 270,
    });
  });

  it.each(["blur", "pointercancel", "visibilitychange"])(
    "cleans up an interrupted drag on %s",
    (type) => {
      document.body.style.cursor = "crosshair";
      document.body.style.userSelect = "text";
      pointer(button, "pointerdown", 400, 360);
      pointer(window, "pointermove", 350, 400);
      if (type === "visibilitychange") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        act(() => document.dispatchEvent(new Event(type)));
      } else if (type === "pointercancel") {
        pointer(window, type, 0, 0);
      } else {
        act(() => window.dispatchEvent(new Event(type)));
      }
      expect(onResizeEnd).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).toHaveBeenLastCalledWith({
        width: 450,
        height: 300,
      });
      expect(document.body.style.cursor).toBe("crosshair");
      expect(document.body.style.userSelect).toBe("text");
      expect(frames.size).toBe(0);
      pointer(window, "pointermove", 0, 0);
      expect(frames.size).toBe(0);
    }
  );

  it("removes listeners and pending work if the grip unmounts mid-drag", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    pointer(button, "pointerdown", 400, 360);
    pointer(window, "pointermove", 350, 400);
    act(() => root.render(null));
    expect(remove.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining([
        "pointermove",
        "pointerup",
        "pointercancel",
        "blur",
      ])
    );
    expect(frames.size).toBe(0);
    expect(onResizeEnd).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
    pointer(window, "pointerup", 0, 0);
    expect(onResizeEnd).not.toHaveBeenCalled();
  });

  it("supports keyboard resizing with the same bounds and commit path", () => {
    act(() =>
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
      )
    );
    expect(onResizeEnd).toHaveBeenLastCalledWith({ width: 410, height: 260 });
    act(() =>
      button.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          shiftKey: true,
          bubbles: true,
        })
      )
    );
    expect(onResizeEnd).toHaveBeenLastCalledWith({ width: 410, height: 300 });
    expect(frames.size).toBe(0);
  });

  it("does not accumulate active listeners across repeated drags", () => {
    for (let index = 0; index < 4; index++) {
      pointer(button, "pointerdown", 400, 360);
      pointer(window, "pointerup", 390, 370);
    }
    expect(onResizeEnd).toHaveBeenCalledTimes(4);
    pointer(window, "pointermove", 0, 0);
    expect(frames.size).toBe(0);
  });
});
