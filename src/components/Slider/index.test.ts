// @vitest-environment jsdom
import { act, createElement } from "react";
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

import Slider from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const railRect: DOMRect = {
  bottom: 10,
  height: 10,
  left: 0,
  right: 100,
  top: 0,
  width: 100,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};

describe("Slider value callbacks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("changes continuously and commits only when a pointer interaction ends", () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();

    act(() => {
      root.render(
        createElement(Slider, {
          defaultValue: 20,
          min: 0,
          max: 100,
          step: 10,
          onValueChange,
          onValueCommit,
        })
      );
    });

    const rail = container.querySelector<HTMLDivElement>(".slider-rail");
    expect(rail).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, "getBoundingClientRect").mockReturnValue(
      railRect
    );

    act(() => {
      rail?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 30 })
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: 70 })
      );
    });

    expect(onValueChange).toHaveBeenCalledWith(30);
    expect(onValueChange).toHaveBeenLastCalledWith(70);
    expect(onValueCommit).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(onValueChange).toHaveBeenLastCalledWith(70);
    expect(onValueCommit).toHaveBeenCalledOnce();
    expect(onValueCommit).toHaveBeenCalledWith(70);
  });

  it("changes and commits each keyboard step without changing slider a11y", () => {
    const events: string[] = [];

    act(() => {
      root.render(
        createElement(Slider, {
          value: 20,
          min: 0,
          max: 100,
          step: 5,
          onValueChange: (value) => events.push(`change:${value}`),
          onValueCommit: (value) => events.push(`commit:${value}`),
        })
      );
    });

    const handle = container.querySelector<HTMLElement>('[role="slider"]');
    expect(handle?.getAttribute("aria-valuemin")).toBe("0");
    expect(handle?.getAttribute("aria-valuemax")).toBe("100");
    expect(handle?.getAttribute("aria-valuenow")).toBe("20");
    expect(handle?.tabIndex).toBe(0);

    act(() => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });

    expect(events).toEqual(["change:25", "commit:25"]);
  });

  it("preserves tuple values for range changes and commits", () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();

    act(() => {
      root.render(
        createElement(Slider, {
          range: true,
          defaultValue: [20, 80],
          min: 0,
          max: 100,
          step: 5,
          onValueChange,
          onValueCommit,
        })
      );
    });

    const handles = container.querySelectorAll<HTMLElement>('[role="slider"]');
    expect(handles).toHaveLength(2);

    act(() => {
      handles[1].dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });

    expect(onValueChange).toHaveBeenCalledWith([20, 85]);
    expect(onValueCommit).toHaveBeenCalledWith([20, 85]);
  });
});
