import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PropertyDropdownDirectionProvider } from "./PropertyDropdownDirection";
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

  it("supports the neutral fill idle surface for table pills", () => {
    const statusMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: false,
        fieldVariant: "pill",
        idleSurface: "fill",
      })
    );
    const assigneeMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "ada",
        label: "Ada",
        icon: null,
        active: false,
        triggerVariant: "iconChevron",
        fieldVariant: "pill",
        idleSurface: "fill",
      })
    );
    const activeStatusMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: true,
        searchable: false,
        fieldVariant: "pill",
        idleSurface: "fill",
      })
    );

    expect(statusMarkup).toContain("!bg-fill-1");
    expect(statusMarkup).toContain("enabled:hover:!bg-fill-2");
    expect(statusMarkup).not.toContain("!bg-bg-2");
    expect(assigneeMarkup).toContain("bg-fill-1");
    expect(assigneeMarkup).toContain("enabled:hover:bg-fill-2");
    expect(activeStatusMarkup).toContain("!bg-fill-2");
    expect(activeStatusMarkup).toContain("!border-primary-6");
  });

  it("matches field hover and open borders when requested", () => {
    const idleStatusMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: false,
        fieldVariant: "pill",
        idleSurface: "fill",
        focusTreatment: "field",
      })
    );
    const activeStatusMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: true,
        searchable: false,
        fieldVariant: "pill",
        idleSurface: "fill",
        focusTreatment: "field",
      })
    );
    const activeAssigneeMarkup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "ada",
        label: "Ada",
        icon: null,
        active: true,
        searchable: false,
        triggerVariant: "iconChevron",
        fieldVariant: "pill",
        idleSurface: "fill",
        focusTreatment: "field",
      })
    );

    expect(idleStatusMarkup).toContain("enabled:hover:!border-border-3");
    expect(activeStatusMarkup).toContain("!border-primary-6");
    expect(activeStatusMarkup).toContain(
      "!shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]"
    );
    expect(activeStatusMarkup).not.toContain("!text-primary-6");
    expect(activeAssigneeMarkup).toContain("!border-primary-6");
    expect(activeAssigneeMarkup).toContain(
      "!shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]"
    );
    expect(activeAssigneeMarkup).not.toContain("text-primary-6");
  });

  it("opens inline property menus above bottom-docked creator rows", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        PropertyDropdownDirectionProvider,
        { direction: "up" },
        React.createElement(PropertyDropdownField, {
          value: "open",
          label: "Open",
          icon: null,
          active: true,
          searchable: false,
          placement: "inline",
          options: [{ value: "open", label: "Open" }],
        })
      )
    );

    expect(markup).toContain("bottom-full mb-1");
    expect(markup).not.toContain("top-full mt-1");
  });
});
