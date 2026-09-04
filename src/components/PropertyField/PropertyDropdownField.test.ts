// @vitest-environment jsdom
import React, { act } from "react";
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

import { DROPDOWN_WIDTHS } from "@src/components/Dropdown/tokens";

import { PropertyDropdownDirectionProvider } from "./PropertyDropdownDirection";
import { PropertyDropdownField } from "./PropertyDropdownField";

describe("PropertyDropdownField", () => {
  it("uses the shared Workstation trail row geometry", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "open",
        label: "Open",
        icon: null,
        active: false,
        fieldVariant: "workstation-trail",
      })
    );

    expect(markup).toContain("h-7");
    expect(markup).toContain("rounded-lg");
    expect(markup).toContain("gap-1.5 pl-2 pr-1.5");
    expect(markup).not.toContain("min-h-8");
    expect(markup).not.toContain("py-1.5");
  });

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

    expect(idleMarkup).toContain("bg-bg-2!");
    expect(idleMarkup).toContain("enabled:hover:bg-surface-hover!");
    expect(activeMarkup).toContain("bg-surface-hover!");
    expect(activeMarkup).toContain("border-primary-6!");
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

    expect(statusMarkup).toContain("bg-fill-1!");
    expect(statusMarkup).toContain("enabled:hover:bg-fill-2!");
    expect(statusMarkup).not.toContain("bg-bg-2!");
    expect(assigneeMarkup).toContain("bg-fill-1");
    expect(assigneeMarkup).toContain("enabled:hover:bg-fill-2");
    expect(activeStatusMarkup).toContain("bg-fill-2!");
    expect(activeStatusMarkup).toContain("border-primary-6!");
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

    expect(idleStatusMarkup).toContain("enabled:hover:border-border-3!");
    expect(activeStatusMarkup).toContain("border-primary-6!");
    expect(activeStatusMarkup).toContain(
      "shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]!"
    );
    expect(activeStatusMarkup).not.toContain("text-primary-6!");
    expect(activeAssigneeMarkup).toContain("border-primary-6!");
    expect(activeAssigneeMarkup).toContain(
      "shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]!"
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

  it("can match an inline dropdown panel to the full trigger width", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PropertyDropdownField, {
        value: "unassigned",
        label: "Unassigned",
        icon: null,
        active: true,
        searchable: false,
        placement: "inline",
        matchTriggerWidth: true,
        options: [{ value: "unassigned", label: "Unassigned" }],
      })
    );

    expect(markup).toContain("right-0 left-0");
    expect(markup).not.toContain(DROPDOWN_WIDTHS.wideMenuClass);
  });
});

describe("PropertyDropdownField portal positioning", () => {
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
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("applies the engine bottom anchor when a portal opens upward", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          PropertyDropdownDirectionProvider,
          { direction: "up" },
          React.createElement(PropertyDropdownField, {
            value: "todo",
            label: "Todo",
            icon: null,
            placement: "portal",
            searchable: false,
            options: [{ value: "todo", label: "Todo" }],
            dataTestId: "work-item-status",
          })
        )
      );
    });

    const field = document.querySelector<HTMLElement>(
      '[data-testid="work-item-status"]'
    );
    const triggerAnchor = field?.firstElementChild as HTMLElement | undefined;
    const trigger = triggerAnchor?.querySelector<HTMLButtonElement>("button");
    expect(triggerAnchor).toBeDefined();
    expect(trigger).not.toBeNull();

    vi.spyOn(triggerAnchor!, "getBoundingClientRect").mockReturnValue({
      top: 400,
      right: 220,
      bottom: 432,
      left: 100,
      width: 120,
      height: 32,
      x: 100,
      y: 400,
      toJSON: () => ({}),
    });

    await act(async () => {
      trigger?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const panel = document.body.querySelector<HTMLElement>(
      "[data-property-dropdown]"
    );
    expect(panel).not.toBeNull();
    expect(panel?.style.top).toBe("");
    expect(panel?.style.bottom).toBe(`${window.innerHeight - 400 + 4}px`);
  });
});
