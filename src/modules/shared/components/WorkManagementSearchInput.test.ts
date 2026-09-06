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
    expect(markup).toContain("w-180");
    expect(markup).toContain('data-icon="x"');
    expect(markup).toContain('title="tooltips.closeEsc"');
  });

  it("fills a split-list header row when requested", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementSearchInput, {
        value: "",
        onChange: vi.fn(),
        fillWidth: true,
        dataTestId: "split-work-search",
      })
    );

    expect(markup).toContain(
      'class="min-w-0 flex-1" data-testid="split-work-search"'
    );
    expect(markup).toContain("w-full min-w-0");
    expect(markup).not.toContain("w-180");
  });

  it("reserves its border and uses fill-2 hover until focus", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementSearchInput, {
        value: "is:issue is:open",
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain("border-transparent!");
    expect(markup).not.toContain("border-0!");
    expect(markup).toContain("hover]:bg-fill-2!");
    expect(markup).toContain("focus-within:border-primary-6!");
    expect(markup).toContain("focus-within:bg-pane-input!");
  });
});
