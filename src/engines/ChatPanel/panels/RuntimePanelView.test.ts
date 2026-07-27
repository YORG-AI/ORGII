import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RuntimePanelView from "./RuntimePanelView";

vi.mock("@src/modules/shared/dataSource", () => ({
  default: () =>
    React.createElement("div", { "data-testid": "runtime-sections" }),
}));

describe("RuntimePanelView", () => {
  it("composes the canonical Runtime data-source sections", () => {
    const markup = renderToStaticMarkup(React.createElement(RuntimePanelView));

    expect(markup).toContain(
      'class="relative flex min-h-0 flex-1 overflow-hidden"'
    );
    expect(markup).toContain('data-testid="runtime-sections"');
  });
});
