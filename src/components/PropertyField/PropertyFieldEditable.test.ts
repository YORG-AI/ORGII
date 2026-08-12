// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SearchableDropdown,
  type SearchableDropdownProps,
} from "./PropertyFieldEditable";

vi.mock("@src/components/Dropdown/DropdownSearch", () => ({
  default: () => createElement("input", { "data-testid": "dropdown-search" }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SearchableDropdown", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("portals a parent-width menu beyond overflow-clipping ancestors", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 80,
      height: 0,
      left: 40,
      right: 280,
      top: 80,
      width: 240,
      x: 40,
      y: 80,
      toJSON: () => ({}),
    });
    const dropdownProps: SearchableDropdownProps = {
      children: () => createElement("span", null, "Option"),
      widthMode: "match-parent",
    };

    act(() => {
      root.render(
        createElement(
          "div",
          { style: { overflow: "hidden" } },
          createElement(SearchableDropdown, dropdownProps)
        )
      );
    });

    expect(container.querySelector("[data-property-dropdown]")).toBeNull();
    const dropdown = document.body.querySelector<HTMLElement>(
      "[data-property-dropdown]"
    );
    expect(dropdown).not.toBeNull();
    expect(dropdown?.style.left).toBe("40px");
    expect(dropdown?.style.top).toBe("80px");
    expect(dropdown?.style.width).toBe("240px");
  });
});
