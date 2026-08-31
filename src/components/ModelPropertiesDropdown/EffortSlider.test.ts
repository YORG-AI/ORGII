// @vitest-environment jsdom
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

import { MODEL_REASONING_LEVEL } from "@src/util/modelVariants";

import { EffortSlider } from "./EffortSlider";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) =>
      options.defaultValue,
  }),
}));

const LEVELS = [
  MODEL_REASONING_LEVEL.LOW,
  MODEL_REASONING_LEVEL.HIGH,
  MODEL_REASONING_LEVEL.EXTRA_HIGH,
];

describe("EffortSlider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibility: DocumentVisibilityState;
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
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, "visibilityState");
    vi.restoreAllMocks();
  });

  function render(
    overrides: Partial<React.ComponentProps<typeof EffortSlider>> = {}
  ) {
    act(() =>
      root.render(
        React.createElement(EffortSlider, {
          levels: LEVELS,
          value: MODEL_REASONING_LEVEL.HIGH,
          onChange: vi.fn(),
          ...overrides,
        })
      )
    );
  }

  function range() {
    const input = container.querySelector<HTMLInputElement>(
      'input[type="range"]'
    );
    if (!input) throw new Error("Effort range is missing");
    return input;
  }

  function changeValue(value: string) {
    const input = range();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps the discrete model contract and accessible label on native input changes", () => {
    const onChange = vi.fn();
    render({ onChange });
    expect(range().min).toBe("0");
    expect(range().max).toBe("2");
    expect(range().step).toBe("1");
    expect(range().getAttribute("aria-label")).toBe("Effort");
    expect(range().getAttribute("aria-valuetext")).toBe("High");

    changeValue("2");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(MODEL_REASONING_LEVEL.EXTRA_HIGH);
    // The parent still owns the selected variant; input does not persist it.
    expect(range().value).toBe("1");
    render({ onChange, value: MODEL_REASONING_LEVEL.EXTRA_HIGH });
    expect(range().getAttribute("aria-valuetext")).toBe("Extra High");
    changeValue("2");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("renders no range for zero or one level, without visibility resources", () => {
    const add = vi.spyOn(document, "addEventListener");
    render({ levels: [] });
    expect(container.textContent).toBe("");
    render({ levels: [MODEL_REASONING_LEVEL.HIGH] });
    expect(container.textContent).toContain("High");
    expect(container.querySelector("input")).toBeNull();
    expect(
      add.mock.calls.filter(([type]) => type === "visibilitychange")
    ).toHaveLength(0);
  });

  it("pauses while hidden, resumes once visible, and removes its listener on close", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    visibility = "hidden";
    render({ fast: true });
    const slider = container.querySelector<HTMLElement>(".effort-slider");
    expect(slider?.dataset.motion).toBe("paused");
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(slider?.dataset.motion).toBe("running");
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(slider?.dataset.motion).toBe("paused");

    act(() => root.render(null));
    const listener = add.mock.calls.find(
      ([type]) => type === "visibilitychange"
    )?.[1];
    expect(remove).toHaveBeenCalledWith("visibilitychange", listener);
    expect(container.querySelector(".effort-slider")).toBeNull();
  });

  it("does not animate the unpositioned panel or accumulate listeners when reopened", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    render({ fast: true, animate: false });
    expect(
      add.mock.calls.filter(([type]) => type === "visibilitychange")
    ).toHaveLength(0);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      render({ fast: true, animate: true });
      expect(
        container.querySelector<HTMLElement>(".effort-slider")?.dataset.motion
      ).toBe("running");
      render({ fast: true, animate: false });
      expect(
        container.querySelector<HTMLElement>(".effort-slider")?.dataset.motion
      ).toBe("paused");
      act(() => root.render(null));
    }
    expect(
      add.mock.calls.filter(([type]) => type === "visibilitychange")
    ).toHaveLength(3);
    expect(
      remove.mock.calls.filter(([type]) => type === "visibilitychange")
    ).toHaveLength(3);
  });
});
