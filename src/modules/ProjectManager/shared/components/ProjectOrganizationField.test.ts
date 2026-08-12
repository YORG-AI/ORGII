// @vitest-environment jsdom
import { type ReactNode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProjectOrganizationField from "./ProjectOrganizationField";

vi.mock("@src/components/PropertyField/PropertyFieldEditable", () => ({
  FieldRow: ({
    label,
    value,
    isActive,
    disabled,
    onClick,
  }: {
    label?: string;
    value: string;
    isActive?: boolean;
    disabled?: boolean;
    onClick: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        disabled,
        "data-testid": "field-row",
        "data-active": String(isActive),
        "data-label": label,
        onClick,
      },
      value
    ),
  SearchableDropdown: ({
    children,
  }: {
    children: (searchQuery: string) => ReactNode;
  }) =>
    createElement("div", { "data-testid": "property-dropdown" }, children("")),
  Option: ({
    label,
    onClick,
    dataTestId,
  }: {
    label: string;
    onClick: () => void;
    dataTestId?: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick, "data-testid": dataTestId },
      label
    ),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ProjectOrganizationField", () => {
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
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("uses one property-row trigger and searchable option list", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        createElement(ProjectOrganizationField, {
          label: "Orgs",
          value: "org-1",
          valueLabel: "ORGII",
          options: [
            {
              value: "org-1",
              label: "ORGII",
              dataTestId: "org-option-1",
            },
            {
              value: "org-2",
              label: "Platform",
              dataTestId: "org-option-2",
            },
          ],
          onChange,
          dataTestId: "project-org-field",
        })
      )
    );

    const fieldRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="field-row"]'
    );
    expect(fieldRow?.textContent).toBe("ORGII");
    expect(fieldRow?.dataset.label).toBe("Orgs");
    expect(fieldRow?.dataset.active).toBe("false");
    expect(fieldRow?.parentElement?.className).not.toContain("px-2");

    act(() => fieldRow?.click());
    expect(
      container.querySelector('[data-testid="property-dropdown"]')
    ).not.toBeNull();

    const secondOption = container.querySelector<HTMLButtonElement>(
      '[data-testid="org-option-2"]'
    );
    act(() => secondOption?.click());

    expect(onChange).toHaveBeenCalledWith("org-2");
    expect(
      container.querySelector('[data-testid="property-dropdown"]')
    ).toBeNull();
  });

  it("uses the Workstation-style value row without a reserved label column", () => {
    act(() =>
      root.render(
        createElement(ProjectOrganizationField, {
          value: "org-1",
          valueLabel: "ORGII",
          options: [{ value: "org-1", label: "ORGII" }],
          onChange: vi.fn(),
        })
      )
    );

    const fieldRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="field-row"]'
    );
    expect(fieldRow?.textContent).toBe("ORGII");
    expect(fieldRow?.hasAttribute("data-label")).toBe(false);
  });
});
