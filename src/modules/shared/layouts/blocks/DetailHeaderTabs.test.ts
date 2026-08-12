import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DetailHeaderTabs from "./DetailHeaderTabs";

describe("DetailHeaderTabs", () => {
  it("keeps title, separator, and tabs in one 40px row", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailHeaderTabs, {
        title: createElement("span", null, "Project title"),
        tabs: createElement("span", null, "Tabs"),
      })
    );

    expect(markup).toContain("h-10");
    expect(markup).toContain('data-testid="detail-header-title"');
    expect(markup).toContain('role="separator"');
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
});
