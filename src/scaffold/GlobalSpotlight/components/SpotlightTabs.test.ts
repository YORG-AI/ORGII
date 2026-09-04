// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpotlightTabs } from "./SpotlightTabs";

type Tab = "one" | "two" | "three";

function Harness({
  onChange,
  shortcut = "tab",
  disableSecond = false,
  format = "pill",
}: {
  onChange: (value: Tab) => void;
  shortcut?: "tab" | "ctrlTab";
  disableSecond?: boolean;
  format?: "pill" | "attached";
}) {
  const [value, setValue] = useState<Tab>("one");
  return createElement(
    "div",
    { "data-spotlight-tabs-scope": true },
    createElement("input", { type: "text", defaultValue: "query" }),
    createElement(SpotlightTabs<Tab>, {
      ariaLabel: "Sources",
      value,
      shortcut,
      format,
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two", disabled: disableSecond },
        { value: "three", label: "Three" },
      ],
      onChange: (next) => {
        onChange(next);
        setValue(next);
      },
    })
  );
}

function press(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

describe("SpotlightTabs", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("wraps in both directions, skips disabled tabs and retains search focus", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(createElement(Harness, { onChange, disableSecond: true }))
    );
    const input = container.querySelector("input")!;
    act(() => input.focus());
    press(input, "Tab");
    press(input, "Tab");
    press(input, "Tab", { shiftKey: true });
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      "three",
      "one",
      "three",
    ]);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("query");
  });

  it("activates focused tabs before row navigation and moves focus with arrow keys", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(Harness, { onChange })));
    const buttons = container.querySelectorAll("button");
    const rowNavigation = vi.fn();
    document.addEventListener("keydown", rowNavigation, true);
    try {
      act(() => buttons[1].focus());
      press(buttons[1], "Enter");
      expect(onChange).toHaveBeenLastCalledWith("two");
      press(buttons[1], "ArrowRight");
      expect(onChange).toHaveBeenLastCalledWith("three");
      expect(document.activeElement).toBe(buttons[2]);
      press(buttons[2], "ArrowLeft");
      expect(document.activeElement).toBe(buttons[1]);
      expect(rowNavigation).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", rowNavigation, true);
    }
  });

  it("keeps Ctrl+Tab palettes' ordinary Tab available for section navigation", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(createElement(Harness, { onChange, shortcut: "ctrlTab" }))
    );
    const input = container.querySelector("input")!;
    expect(press(input, "Tab").defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    press(input, "Tab", { ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith("two");
    press(input, "Tab", { ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("one");
  });

  it("ignores composition, system shortcuts, and events outside its own picker", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(Harness, { onChange })));
    const input = container.querySelector("input")!;
    for (const options of [
      { isComposing: true },
      { metaKey: true },
      { altKey: true },
    ]) {
      expect(press(input, "Tab", options).defaultPrevented).toBe(false);
    }
    expect(press(document.body, "Tab").defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not switch a second mounted picker", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(Harness, { onChange: first }),
          createElement(Harness, { onChange: second })
        )
      )
    );
    const inputs = container.querySelectorAll("input");
    press(inputs[1], "Tab");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith("two");
  });

  it("renders attached tabs and scrolls the newly selected tab into view", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(createElement(Harness, { onChange, format: "attached" }))
    );
    const tablist = container.querySelector('[role="tablist"]');
    const tabs = tablist!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].classList.contains("rounded-t-md")).toBe(true);
    const scroll = vi.fn();
    tabs[1].scrollIntoView = scroll;
    press(container.querySelector("input")!, "Tab");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(-1);
    expect(tabs[1].tabIndex).toBe(0);
    expect(onChange).toHaveBeenCalledWith("two");
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
  });

  it("removes its keyboard listener after every close", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onChange = vi.fn();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      act(() => root.render(createElement(Harness, { onChange })));
      act(() => root.render(null));
    }
    const listeners = add.mock.calls.filter(([name]) => name === "keydown");
    expect(listeners).toHaveLength(5);
    for (const [, listener] of listeners) {
      expect(remove).toHaveBeenCalledWith("keydown", listener, true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});
