// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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

import Checkbox from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "light", isDark: false }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("Checkbox", () => {
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
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("does not transition inherited visibility from hover-only parents", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, {
        checked: false,
        onCheckedChange: vi.fn(),
        ariaLabel: "Select row",
      })
    );

    expect(markup).not.toContain("transition-all");
    expect(markup).toContain(
      "transition-[background-color,border-color,box-shadow]"
    );
    expect(markup).toContain("transition-[opacity,transform]");
  });

  it("reports the next checked state with the native change event", () => {
    const observed: Array<{
      checked: boolean;
      targetChecked: boolean;
      eventType: string;
    }> = [];

    act(() => {
      root.render(
        createElement(Checkbox, {
          defaultChecked: false,
          onCheckedChange: (checked, event) => {
            observed.push({
              checked,
              targetChecked: event.target.checked,
              eventType: event.type,
            });
          },
          ariaLabel: "Select row",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      "[data-checkbox-input]"
    );
    expect(input?.checked).toBe(false);

    act(() => input?.click());
    expect(observed).toEqual([
      { checked: true, targetChecked: true, eventType: "change" },
    ]);
    expect(input?.checked).toBe(true);

    act(() => input?.click());
    expect(observed.at(-1)).toEqual({
      checked: false,
      targetChecked: false,
      eventType: "change",
    });
    expect(input?.checked).toBe(false);
  });

  it("preserves controlled checked state while reporting the attempted change", () => {
    const onCheckedChange = vi.fn();

    act(() => {
      root.render(
        createElement(Checkbox, {
          checked: true,
          onCheckedChange,
          ariaLabel: "Select row",
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      "[data-checkbox-input]"
    );
    act(() => input?.click());

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(false);
    expect(input?.checked).toBe(true);
  });

  it("preserves indeterminate, disabled, form, and accessible markup", () => {
    const onCheckedChange = vi.fn();

    act(() => {
      root.render(
        createElement(Checkbox, {
          defaultChecked: true,
          indeterminate: true,
          disabled: true,
          onCheckedChange,
          ariaLabel: "Select all rows",
        })
      );
    });

    const label = container.querySelector<HTMLLabelElement>("[data-checkbox]");
    const input = container.querySelector<HTMLInputElement>(
      "[data-checkbox-input]"
    );

    expect(label?.getAttribute("aria-label")).toBe("Select all rows");
    expect(input?.type).toBe("checkbox");
    expect(input?.checked).toBe(true);
    expect(input?.indeterminate).toBe(true);
    expect(input?.disabled).toBe(true);
    expect(
      container.querySelector("[data-checkbox-icon] .lucide-minus")
    ).not.toBeNull();

    act(() => input?.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(input?.checked).toBe(true);
  });
});
