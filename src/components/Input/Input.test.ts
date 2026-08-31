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

import Input from ".";

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

describe("Input", () => {
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
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("updates uncontrolled text and clears through the string change contract", () => {
    const observations: Array<{ value: string; eventValue: string }> = [];

    act(() => {
      root.render(
        React.createElement(Input, {
          defaultValue: "draft",
          allowClear: true,
          id: "field",
          onChange: (value, event) => {
            observations.push({ value, eventValue: event.target.value });
          },
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>("#field");
    expect(input?.value).toBe("draft");

    act(() => {
      if (input) setInputValue(input, "updated");
    });
    expect(input?.value).toBe("updated");
    expect(observations).toEqual([{ value: "updated", eventValue: "updated" }]);

    act(() => {
      container.querySelector<HTMLButtonElement>(".input-clear")?.click();
    });
    expect(input?.value).toBe("");
    expect(observations.at(-1)).toEqual({ value: "", eventValue: "" });
    expect(container.querySelector(".input-clear")).toBeNull();
  });

  it("keeps controlled state external while reporting attempted edits", () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        React.createElement(Input, {
          value: "source",
          onChange,
          id: "field",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>("#field");
    act(() => {
      if (input) setInputValue(input, "attempted");
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toBe("attempted");
    expect(input?.value).toBe("source");
  });

  it("lets an explicit clear handler own the clear side effects", () => {
    const onChange = vi.fn();
    const onClear = vi.fn();

    act(() => {
      root.render(
        React.createElement(Input, {
          defaultValue: "draft",
          allowClear: true,
          onChange,
          onClear,
          id: "field",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>("#field");
    act(() => {
      container.querySelector<HTMLButtonElement>(".input-clear")?.click();
    });

    expect(onClear).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(input?.value).toBe("");
  });

  it("preserves field appearance, error layout, focus state, and native attributes", () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();

    act(() => {
      root.render(
        React.createElement(Input, {
          type: "email",
          name: "contact",
          required: true,
          appearance: "ghost",
          size: "large",
          autoHeight: true,
          errorMessage: "Invalid address",
          errorPlacement: "left",
          prefix: React.createElement("span", null, "@"),
          suffix: React.createElement("span", null, ".com"),
          onFocus,
          onBlur,
          "aria-label": "Contact email",
          id: "field",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>("#field");
    const wrapper = container.querySelector<HTMLDivElement>(".input-wrapper");
    const inner = container.querySelector<HTMLDivElement>(".input-inner");

    expect(container.querySelector(".input-field-left")).not.toBeNull();
    expect(container.querySelector(".input-error-message")?.textContent).toBe(
      "Invalid address"
    );
    expect(wrapper?.classList.contains("input-error")).toBe(true);
    expect(wrapper?.classList.contains("input-field-ghost")).toBe(true);
    expect(wrapper?.classList.contains("input-size-large")).toBe(true);
    expect(wrapper?.classList.contains("input-auto-height")).toBe(true);
    expect(inner?.classList.contains("bg-bg-2")).toBe(false);
    expect(container.querySelector(".input-prefix")?.textContent).toBe("@");
    expect(container.querySelector(".input-suffix")?.textContent).toBe(".com");
    expect(input?.type).toBe("email");
    expect(input?.name).toBe("contact");
    expect(input?.required).toBe(true);
    expect(input?.getAttribute("aria-label")).toBe("Contact email");

    act(() => input?.focus());
    expect(wrapper?.classList.contains("input-focused")).toBe(true);
    expect(onFocus).toHaveBeenCalledOnce();

    act(() => input?.blur());
    expect(wrapper?.classList.contains("input-focused")).toBe(false);
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("toggles password visibility without making the action a tab stop", () => {
    act(() => {
      root.render(
        React.createElement(Input, {
          type: "password",
          defaultValue: "secret",
          id: "field",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>("#field");
    const toggle = container.querySelector<HTMLButtonElement>(
      ".input-password-toggle"
    );

    expect(input?.type).toBe("password");
    expect(toggle?.type).toBe("button");
    expect(toggle?.tabIndex).toBe(-1);

    act(() => toggle?.click());
    expect(input?.type).toBe("text");

    act(() => toggle?.click());
    expect(input?.type).toBe("password");
  });
});
