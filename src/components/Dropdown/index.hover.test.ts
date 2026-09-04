// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Dropdown from ".";

describe("Dropdown hover grace", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onVisibleChange = vi.fn();
  const onSelect = vi.fn();

  function render(
    overrides: Partial<React.ComponentProps<typeof Dropdown>> = {}
  ) {
    const props: React.ComponentProps<typeof Dropdown> = {
      trigger: "hover",
      onVisibleChange,
      children: React.createElement("button", null, "Open"),
      droplist: React.createElement(
        "button",
        { "data-testid": "option", onClick: onSelect },
        "Third option"
      ),
      ...overrides,
    };
    act(() => root.render(React.createElement(Dropdown, props)));
    act(() => vi.runAllTicks());
  }
  function move(from: Element | null, to: Element) {
    act(() => {
      from?.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: to })
      );
      to.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: from })
      );
    });
    act(() => vi.runAllTicks());
  }
  function advance(milliseconds: number) {
    act(() => vi.advanceTimersByTime(milliseconds));
    act(() => vi.runAllTicks());
  }
  function trigger() {
    return container.querySelector(".dropdown-trigger-wrapper")!;
  }
  const option = () =>
    document.querySelector<HTMLElement>('[data-testid="option"]');

  beforeEach(() => {
    // Dropdown's position effect uses queueMicrotask as well as animation
    // frames; flush both inside act instead of leaving real microtasks behind.
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "queueMicrotask",
      ],
    });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    onVisibleChange.mockClear();
    onSelect.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it.each([false, true])(
    "allows reaching an option across the gap (portal: %s)",
    (portal) => {
      render(portal ? { getPopupContainer: () => document.body } : {});
      move(null, trigger());
      move(trigger(), document.body);
      advance(300);
      expect(option()).not.toBeNull();
      move(document.body, option()!);
      advance(1000);
      expect(option()).not.toBeNull();
      act(() => option()!.click());
      expect(onSelect).toHaveBeenCalledOnce();
      move(option(), document.body);
      advance(400);
      expect(option()).toBeNull();
    }
  );

  it("replaces repeated leave timers so re-entry cannot close from a stale timer", () => {
    render({ getPopupContainer: () => document.body });
    move(null, trigger());
    move(trigger(), document.body);
    advance(100);
    // A second leave event can precede the panel's enter across portal roots.
    move(trigger(), document.body);
    advance(100);
    move(document.body, option()!);
    advance(1000);
    expect(option()).not.toBeNull();
    expect(onVisibleChange).not.toHaveBeenCalledWith(false);
  });

  it("preserves the caller's immediate-close override", () => {
    render({ hoverCloseDelayMs: 0 });
    move(null, trigger());
    move(trigger(), document.body);
    expect(option()).toBeNull();
  });

  it("discards pending hover dismissal when a controlled menu closes", () => {
    render({ popupVisible: true });
    move(null, trigger());
    move(trigger(), document.body);
    render({ popupVisible: false });
    onVisibleChange.mockClear();
    advance(1000);
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  it("leaves click-open menus open when the pointer leaves", () => {
    render({ trigger: "click", defaultPopupVisible: true });
    move(null, option()!);
    move(option(), document.body);
    advance(1000);
    expect(option()).not.toBeNull();
  });
});
