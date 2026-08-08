import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PropertyDropdownField } from "./PropertyDropdownField";

describe("PropertyDropdownField", () => {
  it("does not build custom options while the dropdown is closed", () => {
    const renderOptions = vi.fn(() =>
      React.createElement("span", null, "Option")
    );

    renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: false,
        renderOptions,
      })
    );

    expect(renderOptions).not.toHaveBeenCalled();
  });

  it("renders disabled options as unavailable", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: true,
        searchable: false,
        options: [
          { value: "open", label: "Open", disabled: true },
          { value: "closed", label: "Closed" },
        ],
        dataTestId: "status",
      })
    );

    expect(markup).toMatch(
      /data-testid="status-option-open"[^>]*disabled=""[^>]*aria-disabled="true"/
    );
    expect(markup).toContain('data-testid="status-option-closed"');
  });

  it("uses the shared background states for pill triggers", () => {
    const idleMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: false,
        fieldVariant: "pill",
      })
    );
    const activeMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: true,
        searchable: false,
        fieldVariant: "pill",
      })
    );

    expect(idleMarkup).toContain("!bg-bg-2");
    expect(idleMarkup).toContain("enabled:hover:!bg-surface-hover");
    expect(activeMarkup).toContain("!bg-surface-hover");
    expect(activeMarkup).toContain("!border-primary-6");
  });
});
