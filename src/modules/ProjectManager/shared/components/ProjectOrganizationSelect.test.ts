import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SelectProps } from "@src/components/Select";

import ProjectOrganizationSelect from "./ProjectOrganizationSelect";

vi.mock("@src/components/Select", () => ({
  default: ({
    className,
    prefix,
    size,
    appearance,
    placement,
    showSearch,
    dropdownMinWidth,
  }: SelectProps & { prefix?: ReactNode }) =>
    createElement(
      "div",
      {
        className,
        "data-size": size,
        "data-appearance": appearance,
        "data-placement": placement,
        "data-search": String(showSearch),
        "data-dropdown-min-width": dropdownMinWidth,
      },
      prefix
    ),
}));

const baseProps = {
  value: "org-1",
  options: [{ value: "org-1", label: "ORGII" }],
  onChange: vi.fn(),
  placeholder: "ORGII",
};

describe("ProjectOrganizationSelect", () => {
  it("owns the shared Workstation-trail formatting and dropdown behavior", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectOrganizationSelect, {
        ...baseProps,
        placement: "top",
      })
    );

    expect(markup).toContain('data-size="small"');
    expect(markup).toContain('data-appearance="ghost"');
    expect(markup).toContain('data-placement="top"');
    expect(markup).toContain('data-search="true"');
    expect(markup).toContain('data-dropdown-min-width="220"');
    expect(markup).toContain("w-fit max-w-[220px]");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("border-border-1");
    expect(markup).toContain("bg-[var(--cm-editor-background)]");
    expect(markup).toContain("shadow-dropdown");
    expect(markup).toContain("w-auto max-w-full");
    expect(markup).toContain("[&amp;_.select-selector]:!h-6");
    expect(markup).toContain("[&amp;_.select-selector]:!text-[13px]");
    expect(markup).toContain("<svg");
  });
});
