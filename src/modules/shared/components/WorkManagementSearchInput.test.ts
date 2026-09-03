import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkManagementSearchInput } from "./WorkManagementSearchInput";

describe("WorkManagementSearchInput", () => {
  it("renders the shared compact page-header search treatment", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementSearchInput, {
        value: "open issue",
        placeholder: "Search work",
        onChange: vi.fn(),
        onClose: vi.fn(),
        dataTestId: "work-search",
      })
    );

    expect(markup).toContain('data-testid="work-search"');
    expect(markup).toContain('type="text"');
    expect(markup).toContain('value="open issue"');
    expect(markup).toContain('aria-label="Search work"');
    expect(markup).toContain("w-64 max-w-[28vw]");
    expect(markup).toContain('data-icon="x"');
    expect(markup).toContain('title="tooltips.closeEsc"');
  });
});
