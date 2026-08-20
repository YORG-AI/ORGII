import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OrganizationScopeHeader } from "./OrganizationScopeHeader";

describe("OrganizationScopeHeader", () => {
  it("keeps the title-row selector permanently chromeless", () => {
    const markup = renderToStaticMarkup(
      createElement(OrganizationScopeHeader, {
        value: "org-1",
        options: [{ value: "org-1", label: "Example organization" }],
        onChange: vi.fn(),
        tabControl: createElement("div", null, "Overview"),
        dataTestId: "organization-header",
        selectorDataTestId: "organization-selector",
      })
    );

    expect(markup).toContain('data-testid="organization-selector"');
    expect(markup).toContain("select-size-large");
    expect(markup).toContain("select-bare");
    expect(markup).toContain("select-title-row");
    expect(markup).not.toContain("select-ghost");
  });
});
