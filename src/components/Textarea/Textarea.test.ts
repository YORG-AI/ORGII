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

import Textarea from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "light", isDark: false }),
}));

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Textarea", () => {
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
        React.createElement(Textarea, {
          defaultValue: "draft",
          allowClear: true,
          id: "field",
          onChange: (value, event) => {
            observations.push({ value, eventValue: event.target.value });
          },
        })
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("#field");
    expect(textarea?.value).toBe("draft");

    act(() => {
      if (textarea) setTextareaValue(textarea, "updated text");
    });
    expect(textarea?.value).toBe("updated text");
    expect(observations).toEqual([
      { value: "updated text", eventValue: "updated text" },
    ]);

    act(() => {
      container.querySelector<HTMLButtonElement>(".textarea-clear")?.click();
    });
    expect(textarea?.value).toBe("");
    expect(observations.at(-1)).toEqual({ value: "", eventValue: "" });
    expect(container.querySelector(".textarea-clear")).toBeNull();
  });

  it("keeps controlled state external while reporting attempted edits", () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        React.createElement(Textarea, {
          value: "source",
          onChange,
          id: "field",
        })
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("#field");
    act(() => {
      if (textarea) setTextareaValue(textarea, "attempted");
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toBe("attempted");
    expect(textarea?.value).toBe("source");
  });

  it("rejects word-count growth beyond the limit but allows correction", () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        React.createElement(Textarea, {
          value: "one two",
          maxWords: 2,
          showWordLimit: true,
          onChange,
          id: "field",
        })
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("#field");
    expect(container.querySelector(".textarea-word-limit")?.textContent).toBe(
      "2/2"
    );

    act(() => {
      if (textarea) setTextareaValue(textarea, "one two three");
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(textarea?.value).toBe("one two");

    act(() => {
      root.render(
        React.createElement(Textarea, {
          value: "one two three",
          maxWords: 2,
          showWordLimit: true,
          onChange,
          id: "field",
        })
      );
    });
    expect(
      container
        .querySelector(".textarea-wrapper")
        ?.classList.contains("textarea-error")
    ).toBe(true);

    const overLimitTextarea =
      container.querySelector<HTMLTextAreaElement>("#field");
    act(() => {
      if (overLimitTextarea) setTextareaValue(overLimitTextarea, "one two");
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toBe("one two");
  });

  it("preserves appearance, focus, resize, and native attributes", () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();

    act(() => {
      root.render(
        React.createElement(Textarea, {
          appearance: "bare",
          size: "large",
          error: true,
          resize: "horizontal",
          rows: 5,
          name: "notes",
          required: true,
          onFocus,
          onBlur,
          "aria-label": "Notes",
          id: "field",
        })
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("#field");
    const wrapper =
      container.querySelector<HTMLDivElement>(".textarea-wrapper");
    const inner = container.querySelector<HTMLDivElement>(".textarea-inner");

    expect(wrapper?.classList.contains("textarea-field-bare")).toBe(true);
    expect(wrapper?.classList.contains("textarea-size-large")).toBe(true);
    expect(wrapper?.classList.contains("textarea-error")).toBe(true);
    expect(inner?.classList.contains("bg-bg-2")).toBe(false);
    expect(textarea?.style.resize).toBe("horizontal");
    expect(textarea?.rows).toBe(5);
    expect(textarea?.name).toBe("notes");
    expect(textarea?.required).toBe(true);
    expect(textarea?.getAttribute("aria-label")).toBe("Notes");

    act(() => textarea?.focus());
    expect(wrapper?.classList.contains("textarea-focused")).toBe(true);
    expect(onFocus).toHaveBeenCalledOnce();

    act(() => textarea?.blur());
    expect(wrapper?.classList.contains("textarea-focused")).toBe(false);
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("hides clear actions for disabled and readonly values", () => {
    act(() => {
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement(Textarea, {
            defaultValue: "disabled",
            allowClear: true,
            disabled: true,
            id: "disabled-field",
          }),
          React.createElement(Textarea, {
            defaultValue: "readonly",
            allowClear: true,
            readOnly: true,
            id: "readonly-field",
          })
        )
      );
    });

    expect(container.querySelectorAll(".textarea-clear")).toHaveLength(0);
    expect(
      container.querySelector<HTMLTextAreaElement>("#disabled-field")?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLTextAreaElement>("#readonly-field")?.readOnly
    ).toBe(true);
  });
});
