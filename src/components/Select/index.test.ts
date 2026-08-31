// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import Select from ".";

describe("Select ghost presentation", () => {
  it("shares the ghost input hover surface while hovered or open", () => {
    const styles = readFileSync(resolve(__dirname, "index.scss"), "utf8");
    const stateRule = styles.match(
      /\.select-ghost:hover:not\(\.select-disabled\)[\s\S]*?\{[\s\S]*?\}/
    )?.[0];

    expect(stateRule).toContain(".select-ghost.select-open .select-selector");
    expect(stateRule).toContain("background: var(--color-surface-hover)");
  });
});

describe("Select keyboard navigation", () => {
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

  it("navigates and selects options while focus is in the portaled search input", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(Select, {
          value: "one",
          options: [
            { label: "One", value: "one", dataTestId: "select-option-one" },
            { label: "Two", value: "two", dataTestId: "select-option-two" },
          ],
          onChange,
          showSearch: true,
          defaultPopupVisible: true,
          ariaLabel: "Repository",
        })
      );
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const searchInput =
      document.body.querySelector<HTMLInputElement>('input[type="text"]');
    expect(searchInput).not.toBeNull();
    act(() => searchInput?.focus());
    expect(document.activeElement).toBe(searchInput);

    act(() => {
      searchInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });

    const secondOption = document.body.querySelector<HTMLElement>(
      '[data-testid="select-option-two"]'
    );
    expect(secondOption?.getAttribute("role")).toBe("option");
    expect(secondOption?.getAttribute("aria-selected")).toBe("false");
    expect(secondOption?.classList.contains("bg-fill-2")).toBe(true);

    act(() => {
      searchInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(onChange).toHaveBeenCalledWith(
      "two",
      expect.objectContaining({ value: "two" })
    );
  });
});
