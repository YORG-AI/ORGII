import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SplitListHeader from "./SplitListHeader";

describe("SplitListHeader", () => {
  it("renders its rows without a bottom divider", () => {
    const markup = renderToStaticMarkup(
      createElement(SplitListHeader, {
        primary: createElement("span", null, "Context"),
        secondary: createElement("span", null, "Search"),
      })
    );

    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).not.toContain("border-b");
    expect(markup).not.toContain("border-border-2");
  });

  it("uses the host inset for a full-width surface row", () => {
    const markup = renderToStaticMarkup(
      createElement(SplitListHeader, {
        fullWidth: true,
        primary: createElement("span", null, "Controls"),
      })
    );

    expect(markup).toContain("h-9");
    expect(markup).toContain("pl-[15px]");
    expect(markup).toContain("pr-[7px]");
  });
});
