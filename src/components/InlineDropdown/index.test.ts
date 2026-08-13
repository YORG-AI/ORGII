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

import InlineDropdown from ".";

describe("InlineDropdown keyboard navigation", () => {
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

  it("navigates searchable custom options from the search field", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(InlineDropdown, {
          value: "two",
          options: [
            { label: "One", value: "one" },
            { label: "Two", value: "two" },
          ],
          onChange,
          showSearch: true,
        })
      );
    });

    const trigger = container.querySelector<HTMLElement>(
      ".dropdown-trigger-wrapper"
    );
    expect(trigger?.tabIndex).toBe(0);
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve())
      );
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[type="search"]'
    );
    expect(searchInput).not.toBeNull();
    const optionRows = Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]')
    );
    expect(optionRows).toHaveLength(2);
    optionRows.forEach((row) => {
      Object.defineProperty(row, "offsetParent", {
        configurable: true,
        value: row.parentElement,
      });
      Object.defineProperty(row, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });
    });
    act(() => searchInput?.focus());

    act(() => {
      searchInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(optionRows[0].getAttribute("data-dropdown-keyboard-highlight")).toBe(
      "true"
    );

    act(() => {
      searchInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onChange).toHaveBeenCalledWith("one", undefined);
  });
});
