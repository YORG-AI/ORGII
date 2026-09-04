import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SplitViewLayout from "./SplitViewLayout";

describe("SplitViewLayout", () => {
  it("keeps the shared list header with the split content", () => {
    const markup = renderToStaticMarkup(
      createElement(SplitViewLayout, {
        listHeader: createElement("header", null, "List header"),
        listContent: createElement("div", null, "List content"),
        mainContent: createElement("div", null, "Detail content"),
        listWidth: 240,
      })
    );

    expect(markup).toContain("List header");
    expect(markup).toContain("List content");
    expect(markup).toContain("Detail content");
  });

  it("can preserve resizing without drawing a resting divider", () => {
    const markup = renderToStaticMarkup(
      createElement(SplitViewLayout, {
        listContent: createElement("div", null, "List content"),
        mainContent: createElement("div", null, "Detail content"),
        listWidth: 240,
        showDivider: false,
      })
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain("bg-transparent");
    expect(markup).not.toContain("bg-border-2");
  });
});
