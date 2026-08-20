import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SelectProps } from "@src/components/Select";

import ProjectOrganizationSelect from "./ProjectOrganizationSelect";

vi.mock("@src/components/Select", () => ({
  default: ({
    className,
    selectorClassName,
    prefix,
    size,
    appearance,
    radius,
    placement,
    showSearch,
    dropdownMinWidth,
  }: SelectProps & { prefix?: ReactNode }) =>
    createElement(
      "div",
      {
        className,
        "data-selector-class": selectorClassName,
        "data-size": size,
        "data-appearance": appearance,
        "data-radius": radius,
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
  it("uses the standard creator pill shape and dropdown behavior", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectOrganizationSelect, {
        ...baseProps,
        placement: "top",
      })
    );

    expect(markup).toContain('data-size="small"');
    expect(markup).toContain('data-radius="pill"');
    expect(markup).not.toContain('data-appearance="ghost"');
    expect(markup).toContain('data-placement="top"');
    expect(markup).toContain('data-search="true"');
    expect(markup).toContain('data-dropdown-min-width="220"');
    expect(markup).toContain("w-auto max-w-[220px]");
    expect(markup).toContain("!h-7 !rounded-full !bg-bg-2 !px-3");
    expect(markup).toContain("!text-[13px] !font-medium !shadow-none");
    expect(markup).not.toContain("rounded-xl");
    expect(markup).not.toContain("shadow-dropdown");
    expect(markup).toContain("<svg");
  });
});
