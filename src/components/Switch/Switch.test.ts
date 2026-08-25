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

import Switch from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "light", isDark: false }),
}));

describe("Switch", () => {
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

  it("delivers the next uncontrolled state during mouse activation", () => {
    const observations: Array<{
      checked: boolean;
      eventType: string;
      eventDetail: number;
      ariaCheckedDuringCallback: string | null;
    }> = [];

    act(() => {
      root.render(
        React.createElement(Switch, {
          defaultChecked: true,
          ariaLabel: "Enable feature",
          dataTestId: "switch",
          onCheckedChange: (checked, event) => {
            observations.push({
              checked,
              eventType: event.type,
              eventDetail: event.detail,
              ariaCheckedDuringCallback:
                event.currentTarget.getAttribute("aria-checked"),
            });
          },
        })
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="switch"]'
    );
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("role")).toBe("switch");
    expect(button?.getAttribute("aria-label")).toBe("Enable feature");
    expect(button?.getAttribute("aria-checked")).toBe("true");

    act(() => {
      button?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 1 })
      );
    });

    expect(observations).toEqual([
      {
        checked: false,
        eventType: "click",
        eventDetail: 1,
        ariaCheckedDuringCallback: "true",
      },
    ]);
    expect(button?.getAttribute("aria-checked")).toBe("false");
    expect(button?.classList.contains("switch-checked")).toBe(false);
  });

  it("waits for native keyboard activation and keeps controlled state external", () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        React.createElement(Switch, {
          checked: false,
          onCheckedChange,
          dataTestId: "switch",
        })
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="switch"]'
    );
    act(() => {
      button?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true })
      );
    });
    expect(onCheckedChange).not.toHaveBeenCalled();

    act(() => {
      button?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 0 })
      );
    });

    expect(onCheckedChange).toHaveBeenCalledOnce();
    expect(onCheckedChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ type: "click", detail: 0 })
    );
    expect(button?.getAttribute("aria-checked")).toBe("false");
  });

  it.each([
    { disabled: true, loading: false },
    { disabled: false, loading: true },
  ])("blocks activation while disabled or loading: %o", (blockedState) => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        React.createElement(Switch, {
          checked: false,
          ...blockedState,
          onCheckedChange,
          dataTestId: "switch",
        })
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="switch"]'
    );
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(button?.getAttribute("aria-checked")).toBe("false");
  });
});
