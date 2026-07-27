import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DropdownItem, { type DropdownItemProps } from "./DropdownItem";

const TestDropdownItem = DropdownItem as unknown as React.ComponentType<
  Omit<DropdownItemProps, "children">
>;

describe("DropdownItem accessibility contract", () => {
  it("renders a focusable full-width action menu row without option state", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TestDropdownItem,
        {
          role: "menuitem",
          fullWidth: true,
          tabIndex: 0,
        },
        "Open"
      )
    );

    expect(markup).toContain('role="menuitem"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("w-full");
    expect(markup).not.toContain("aria-selected");
  });

  it("removes disabled action rows from the tab order", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TestDropdownItem,
        {
          role: "menuitem",
          tabIndex: 0,
          disabled: true,
        },
        "Delete"
      )
    );

    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-disabled="true"');
  });

  it("preserves listbox option selection semantics by default", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TestDropdownItem,
        { selected: true },
        "Selected option"
      )
    );

    expect(markup).toContain('role="option"');
    expect(markup).toContain('aria-selected="true"');
  });
});
