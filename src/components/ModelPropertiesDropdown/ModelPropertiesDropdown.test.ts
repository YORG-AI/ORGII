// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
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

import { activeOverlayCountAtom } from "@src/store/ui/overlayLayerAtom";
import { buildVariantEditOptions } from "@src/util/variantEditOptions";

import ModelPropertiesDropdown from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) =>
      options.defaultValue,
  }),
}));

const MODELS = ["low", "medium", "high", "xhigh", "max", "ultra"].flatMap(
  (effort) => [`gpt-5.6-sol-${effort}`, `gpt-5.6-sol-${effort}-fast`]
);

describe("ModelPropertiesDropdown immediate changes", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const save = vi.fn();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });
  beforeEach(() => {
    vi.useFakeTimers();
    save.mockClear();
    store = createStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(value: string, models = MODELS) {
    const options = buildVariantEditOptions(models);
    act(() =>
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(ModelPropertiesDropdown, {
            value,
            variantOptions: options,
            onChange: (modelId) => {
              save(modelId);
              render(modelId, models);
            },
            renderTrigger: ({ ref, onClick, ariaExpanded }) =>
              React.createElement(
                "button",
                {
                  ref,
                  onClick,
                  "aria-expanded": ariaExpanded,
                  "data-testid": "trigger",
                },
                value
              ),
          })
        )
      )
    );
  }
  function trigger() {
    return container.querySelector<HTMLButtonElement>("button")!;
  }
  function open() {
    act(() => trigger().click());
    act(() => vi.advanceTimersByTime(32));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  }
  function range() {
    const input = document.querySelector<HTMLInputElement>(
      'input[type="range"]'
    );
    if (!input) throw new Error("Effort range is missing");
    return input;
  }
  function changeRange(value: string) {
    const input = range();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function toggle(label: string) {
    const button = document.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="${label}"]`
    );
    if (!button) throw new Error(`${label} switch is missing`);
    act(() => button.click());
  }
  function escape() {
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  }

  it("saves valid effort and Fast changes without a footer, and stays open", () => {
    render("gpt-5.6-sol-high-fast");
    open();
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toMatch(
      /Cancel|Apply/
    );
    changeRange("4");
    expect(save).toHaveBeenLastCalledWith("gpt-5.6-sol-ultra-fast");
    expect(range().getAttribute("aria-valuetext")).toBe("Ultra");
    toggle("Fast");
    expect(save).toHaveBeenLastCalledWith("gpt-5.6-sol-ultra");
    expect(save).toHaveBeenCalledTimes(2);
    escape();
    expect(save).toHaveBeenCalledTimes(2);
    open();
    expect(range().getAttribute("aria-valuetext")).toBe("Ultra");
    expect(trigger().textContent).toBe("gpt-5.6-sol-ultra");
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("clears unsupported Fast before saving the next effort", () => {
    render("gpt-5.6-sol-high-fast", [
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-high-fast",
      "gpt-5.6-sol-ultra",
    ]);
    open();
    changeRange("1");
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("gpt-5.6-sol-ultra");
    expect(
      document.querySelector('[role="switch"][aria-label="Fast"]')
    ).toBeNull();
  });

  it("applies Thinking changes and ignores unavailable combinations", () => {
    const models = [
      "claude-opus-4-7-low",
      "claude-opus-4-7-high",
      "claude-opus-4-7-thinking-low",
    ];
    render("claude-opus-4-7-low", models);
    open();
    toggle("Thinking");
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("claude-opus-4-7-thinking-low");
    changeRange("1");
    expect(save).toHaveBeenCalledTimes(1);
    expect(range().getAttribute("aria-valuetext")).toBe("Light");
  });

  it("uses refreshed values without writing and closes outside without reverting", () => {
    render("gpt-5.6-sol-max");
    open();
    expect(range().getAttribute("aria-valuetext")).toBe("Max");
    render("gpt-5.6-sol-medium");
    expect(range().getAttribute("aria-valuetext")).toBe("Medium");
    expect(save).not.toHaveBeenCalled();
    act(() =>
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true })
      )
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(store.get(activeOverlayCountAtom)).toBe(0);
    open();
    expect(range().getAttribute("aria-valuetext")).toBe("Medium");
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves native range keys unhandled and saves once on key release", () => {
    render("gpt-5.6-sol-high");
    open();
    const down = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      range().focus();
      range().dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(false);
    changeRange("3");
    changeRange("4");
    expect(save).not.toHaveBeenCalled();
    act(() =>
      range().dispatchEvent(
        new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true })
      )
    );
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("gpt-5.6-sol-ultra");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(range());
  });
});
