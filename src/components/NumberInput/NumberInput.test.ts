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

import NumberInput from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "light", isDark: false }),
}));

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NumberInput", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("delivers stepped values through onValueChange for keyboard and button controls", () => {
    const onValueChange = vi.fn();
    act(() => {
      root.render(
        React.createElement(NumberInput, {
          value: 4,
          min: 0,
          max: 5,
          step: 0.25,
          onValueChange,
          dataTestId: "number-input",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="number-input"]'
    );
    expect(input).not.toBeNull();
    expect(input?.type).toBe("text");
    expect(input?.inputMode).toBe("decimal");

    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".number-input-btn-down")
        ?.click();
    });

    expect(onValueChange).toHaveBeenNthCalledWith(1, 4.25);
    expect(onValueChange).toHaveBeenNthCalledWith(2, 3.75);
  });

  it("preserves parse, step rounding, and clamping behavior on blur", () => {
    const onValueChange = vi.fn();
    act(() => {
      root.render(
        React.createElement(NumberInput, {
          defaultValue: 1.2,
          min: 1,
          max: 2,
          step: 0.1,
          onValueChange,
          dataTestId: "number-input",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="number-input"]'
    );
    expect(input).not.toBeNull();

    act(() => input?.focus());
    act(() => {
      if (input) setInputValue(input, "1.26");
    });
    act(() => input?.blur());

    expect(onValueChange).toHaveBeenLastCalledWith(1.3);
    expect(input?.value).toBe("1.3");

    act(() => input?.focus());
    act(() => {
      if (input) setInputValue(input, "9");
    });
    act(() => input?.blur());

    expect(onValueChange).toHaveBeenLastCalledWith(2);
    expect(input?.value).toBe("2");
  });

  it("restores the current value without emitting when the draft is empty", () => {
    const onValueChange = vi.fn();
    act(() => {
      root.render(
        React.createElement(NumberInput, {
          defaultValue: 1500,
          onValueChange,
          dataTestId: "number-input",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="number-input"]'
    );
    expect(input?.value).toBe("1,500");

    act(() => input?.focus());
    expect(input?.value).toBe("1500");
    act(() => {
      if (input) setInputValue(input, "");
    });
    act(() => input?.blur());

    expect(onValueChange).not.toHaveBeenCalled();
    expect(input?.value).toBe("1,500");
  });
});
