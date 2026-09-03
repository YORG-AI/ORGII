import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DetailHeaderTabs from "./DetailHeaderTabs";

describe("DetailHeaderTabs", () => {
  it("keeps title and tabs in one 36px row without a decorative separator", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailHeaderTabs, {
        title: createElement("span", null, "Project title"),
        tabs: createElement("span", null, "Tabs"),
      })
    );

    expect(markup).toContain("h-9");
    expect(markup).not.toContain("h-10");
    expect(markup).toContain('data-testid="detail-header-title"');
    expect(markup).not.toContain('role="separator"');
    expect(markup).not.toContain("detail-header-tabs-separator");
    expect(markup).toContain('data-testid="detail-header-tabs"');
    expect(markup.indexOf("Project title")).toBeLessThan(
      markup.indexOf("Tabs")
    );
  });

  it("uses the full row for a title when tabs are absent", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailHeaderTabs, { title: "Work item" })
    );

    expect(markup).toContain("flex-1");
    expect(markup).not.toContain('role="separator"');
  });

  it("stacks title and tabs below the PR detail container breakpoint", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailHeaderTabs, {
        title: createElement("span", null, "Pull request title"),
        tabs: createElement("span", null, "Pull request tabs"),
        stackTabsBelow: true,
      })
    );

    expect(markup).toContain("flex-col");
    expect(markup).toContain("@[960px]/detailheader:flex-row");
    expect(markup).toContain("@[960px]/detailheader:h-9");
    expect(markup).toContain('data-testid="detail-header-tabs"');
    expect(markup).not.toContain('role="separator"');
  });
});
