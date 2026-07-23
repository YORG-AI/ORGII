import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RuntimePanelView from "./RuntimePanelView";

vi.mock("@src/modules/shared/dataSource", () => ({
  default: ({
    assetsContent,
    quotaContent,
  }: {
    assetsContent: React.ReactNode;
    quotaContent: React.ReactNode;
  }) =>
    React.createElement("div", {
      "data-testid": "runtime-sections",
      "data-has-assets": Boolean(assetsContent),
      "data-has-quota": Boolean(quotaContent),
    }),
}));

vi.mock("../StartPageQuotaGrid", () => ({
  StartPageQuotaGrid: () => null,
}));

vi.mock("./WorkspaceDashboardPanelView", () => ({
  default: () => null,
}));

describe("RuntimePanelView", () => {
  it("composes the canonical Runtime data-source sections", () => {
    const markup = renderToStaticMarkup(React.createElement(RuntimePanelView));

    expect(markup).toContain(
      'class="relative flex min-h-0 flex-1 overflow-hidden"'
    );
    expect(markup).toContain('data-testid="runtime-sections"');
    expect(markup).toContain('data-has-assets="true"');
    expect(markup).toContain('data-has-quota="true"');
  });
});
