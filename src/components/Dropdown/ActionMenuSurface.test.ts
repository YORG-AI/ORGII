// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionMenuSurface, ActionSubmenu } from "./ActionMenuSurface";

describe("ActionMenuSurface hover navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let panelRef: React.RefObject<HTMLDivElement | null>;
  const selectThird = vi.fn();
  const onClose = vi.fn();

  function Menu() {
    const controlsProps: React.ComponentProps<typeof ActionSubmenu> = {
      label: "UI controls",
      icon: null,
      dataTestId: "controls",
      children: [1, 2, 3].map((number) =>
        React.createElement(
          "button",
          { key: number, onClick: number === 3 ? selectThird : undefined },
          `Option ${number}`
        )
      ),
    };
    const otherProps: React.ComponentProps<typeof ActionSubmenu> = {
      label: "Other group",
      icon: null,
      dataTestId: "other-group",
      children: React.createElement("button", null, "Another option"),
    };
    return React.createElement(
      ActionMenuSurface,
      { panelRef, onClose },
      React.createElement(ActionSubmenu, controlsProps),
      React.createElement(
        "button",
        { "data-testid": "sibling" },
        "Other action"
      ),
      React.createElement(ActionSubmenu, otherProps)
    );
  }

  function element(selector: string) {
    const result = container.querySelector<HTMLElement>(selector);
    expect(result, selector).not.toBeNull();
    return result!;
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
  }

  function advance(milliseconds: number) {
    act(() => vi.advanceTimersByTime(milliseconds));
  }

  const isOpen = () =>
    container.querySelector('[data-testid="controls-panel"]') !== null;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    selectThird.mockClear();
    onClose.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    panelRef = createRef<HTMLDivElement>();
    act(() => root.render(React.createElement(Menu)));
    move(null, element('[data-testid="controls"]'));
    expect(isOpen()).toBe(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("lets the pointer cross empty space and select the third option", () => {
    const trigger = element('[data-testid="controls"]');
    move(trigger, document.body);
    advance(300);
    expect(isOpen()).toBe(true);
    const third = element('[data-testid="controls-panel"] button:nth-child(3)');
    move(document.body, third);
    advance(1000);
    expect(isOpen()).toBe(true);
    act(() => third.click());
    expect(selectThird).toHaveBeenCalledOnce();
  });

  it.each(["sibling", "other-group"])(
    "keeps the current submenu while crossing %s diagonally",
    (testId) => {
      const crossed = element(`[data-testid="${testId}"]`);
      move(element('[data-testid="controls"]'), crossed);
      advance(150);
      expect(isOpen()).toBe(true);
      move(
        crossed,
        element('[data-testid="controls-panel"] button:nth-child(3)')
      );
      advance(1000);
      expect(isOpen()).toBe(true);
      expect(
        container.querySelector('[data-testid="other-group-panel"]')
      ).toBeNull();
    }
  );

  it("switches submenus after an intentional hover on another group", () => {
    move(
      element('[data-testid="controls"]'),
      element('[data-testid="other-group"]')
    );
    advance(400);
    expect(isOpen()).toBe(false);
    expect(
      container.querySelector('[data-testid="other-group-panel"]')
    ).not.toBeNull();
  });

  it("closes after leaving, but re-entry cancels the pending close", () => {
    move(element('[data-testid="controls"]'), document.body);
    advance(200);
    move(document.body, element('[data-testid="controls"]'));
    advance(1000);
    expect(isOpen()).toBe(true);
    move(element('[data-testid="controls"]'), document.body);
    advance(400);
    expect(isOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lets a click override a pending hover switch immediately", () => {
    const other = element('[data-testid="other-group"]');
    move(element('[data-testid="controls"]'), other);
    act(() => other.click());
    expect(
      container.querySelector('[data-testid="other-group-panel"]')
    ).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps keyboard navigation immediate and discards stale hover intent", () => {
    move(
      element('[data-testid="controls"]'),
      element('[data-testid="other-group"]')
    );
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true })
      )
    );
    expect(document.activeElement?.textContent).toBe("Option 3");
    advance(1000);
    expect(isOpen()).toBe(true);
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(element('[data-testid="controls"]'));
    // jsdom schedules a selectionchange task when focus returns to the row.
    advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
