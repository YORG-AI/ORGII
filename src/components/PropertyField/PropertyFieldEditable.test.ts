// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SearchableDropdown,
  type SearchableDropdownProps,
  getPropertyDropdownAlign,
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

  it("waits to reveal an auto-aligned menu until its right edge is resolved", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1_000,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.dataset.propertyDropdown !== undefined) {
          return {
            bottom: 300,
            height: 220,
            left: 800,
            right: 1_100,
            top: 80,
            width: 300,
            x: 800,
            y: 80,
            toJSON: () => ({}),
          };
        }

        return {
          bottom: 80,
          height: 0,
          left: 800,
          right: 800,
          top: 80,
          width: 0,
          x: 800,
          y: 80,
          toJSON: () => ({}),
        };
      }
    );
    const dropdownProps: SearchableDropdownProps = {
      align: "auto",
      children: () => createElement("span", null, "Option"),
      widthMode: "menu",
    };

    act(() => {
      root.render(createElement(SearchableDropdown, dropdownProps));
    });

    const dropdown = document.body.querySelector<HTMLElement>(
      "[data-property-dropdown]"
    );
    expect(dropdown).not.toBeNull();
    expect(dropdown?.style.left).toBe("");
    expect(dropdown?.style.right).toBe("200px");
    expect(dropdown?.style.visibility).toBe("visible");
    expect(dropdown?.style.pointerEvents).toBe("auto");
  });
});

describe("getPropertyDropdownAlign", () => {
  it("anchors pill picker menus by their right edge", () => {
    expect(getPropertyDropdownAlign("pill")).toBe("right");
    expect(getPropertyDropdownAlign("row")).toBe("left");
    expect(getPropertyDropdownAlign("workstation-trail")).toBe("left");
  });
});
