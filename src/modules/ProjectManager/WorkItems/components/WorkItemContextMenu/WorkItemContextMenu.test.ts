// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "@src/types/core/shared";

import WorkItemContextMenu from ".";

describe("WorkItemContextMenu hover navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const selectThird = vi.fn();
  const onClose = vi.fn();
  const items: ContextMenuItem[] = [
    {
      id: "group",
      label: "Group",
      submenu: [
        {
          id: "nested",
          label: "Nested group",
          submenu: [
            { id: "nested-first", label: "Nested first" },
            { id: "nested-second", label: "Nested second" },
            { id: "nested-third", label: "Nested third", action: selectThird },
          ],
        },
        { id: "second", label: "Second" },
        { id: "third", label: "Third", action: selectThird },
      ],
    },
    { id: "sibling", label: "Sibling" },
  ];

  function element(selector: string) {
    const result = document.querySelector<HTMLElement>(selector);
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
  const panels = () =>
    document.querySelectorAll(".work-item-context-menu--submenu");

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    onClose.mockClear();
    selectThird.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        React.createElement(WorkItemContextMenu, {
          items,
          position: { x: 200, y: 100 },
          onClose,
        })
      )
    );
    move(null, element('[data-testid="context-menu-item-group"]'));
    expect(panels()).toHaveLength(1);
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("allows crossing the gap to the third option in the portaled submenu", () => {
    move(element('[data-testid="context-menu-item-group"]'), document.body);
    advance(300);
    expect(panels()).toHaveLength(1);
    const third = panels()[0].querySelector<HTMLElement>(
      "button:nth-child(3)"
    )!;
    move(document.body, third);
    advance(1000);
    expect(panels()).toHaveLength(1);
    act(() => third.click());
    expect(selectThird).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close the submenu while crossing an adjacent parent row", () => {
    const sibling = element('[data-testid="context-menu-item-sibling"]');
    move(element('[data-testid="context-menu-item-group"]'), sibling);
    advance(150);
    expect(panels()).toHaveLength(1);
    move(sibling, panels()[0].querySelector("button:nth-child(3)")!);
    advance(1000);
    expect(panels()).toHaveLength(1);
  });

  it("protects the same diagonal path into a third-level submenu", () => {
    const nested = panels()[0].querySelector("button")!;
    move(element('[data-testid="context-menu-item-group"]'), nested);
    expect(panels()).toHaveLength(2);
    const second = panels()[0].querySelector("button:nth-child(2)")!;
    move(nested, second);
    advance(150);
    expect(panels()).toHaveLength(2);
    move(second, document.body);
    advance(200);
    const third = panels()[1].querySelector<HTMLElement>(
      "button:nth-child(3)"
    )!;
    move(document.body, third);
    advance(1000);
    expect(panels()).toHaveLength(2);
    act(() => third.click());
    expect(selectThird).toHaveBeenCalledOnce();
  });

  it("closes submenus after deliberately hovering another parent action", () => {
    move(
      element('[data-testid="context-menu-item-group"]'),
      element('[data-testid="context-menu-item-sibling"]')
    );
    advance(400);
    expect(panels()).toHaveLength(0);
  });

  it("replaces leave timers and cancels all pending closes on re-entry", () => {
    const trigger = element('[data-testid="context-menu-item-group"]');
    move(trigger, document.body);
    advance(100);
    move(trigger, document.body);
    advance(100);
    move(document.body, panels()[0]);
    advance(1000);
    expect(panels()).toHaveLength(1);
    move(panels()[0], document.body);
    advance(400);
    expect(panels()).toHaveLength(0);
  });
});
