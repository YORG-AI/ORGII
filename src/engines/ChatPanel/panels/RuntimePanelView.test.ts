import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RuntimePanelView from "./RuntimePanelView";

vi.mock("@src/modules/shared/dataSource", () => ({
  default: ({
    hideHeader,
    hideScrollbars,
  }: {
    hideHeader?: boolean;
    hideScrollbars?: boolean;
  }) =>
    React.createElement("div", {
      "data-testid": "runtime-sections",
      "data-header-mode": hideHeader ? "hidden" : "pinned-tabs",
      "data-scrollbars": hideScrollbars ? "hidden" : "visible",
    }),
}));

vi.mock("../StartPageQuotaGrid", () => ({
  StartPageQuotaGrid: () => null,
}));

vi.mock("./WorkspaceDashboardPanelView", () => ({
  default: () => null,
}));

describe("RuntimePanelView", () => {
  it("keeps the section tabs pinned inside the Runtime panel", () => {
    const markup = renderToStaticMarkup(React.createElement(RuntimePanelView));

    expect(markup).toContain(
      'class="relative flex min-h-0 flex-1 overflow-hidden"'
    );
    expect(markup).toContain('data-testid="runtime-sections"');
    expect(markup).toContain('data-header-mode="pinned-tabs"');
    expect(markup).toContain('data-scrollbars="hidden"');
  });
});
