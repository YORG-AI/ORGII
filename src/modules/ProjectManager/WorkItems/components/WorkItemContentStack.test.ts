import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkItemContentStack from "./WorkItemContentStack";

describe("WorkItemContentStack", () => {
  it("can render title and metadata without divider borders", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemContentStack, {
        titleContent: createElement("span", null, "Title"),
        pathContent: createElement("span", null, "Project"),
        propertiesContent: createElement("span", null, "Status"),
        showDividers: false,
      })
    );

    expect(markup).toContain("Title");
    expect(markup).toContain("Project");
    expect(markup).toContain("Status");
    expect(markup).not.toContain("border-t");
    expect(markup).not.toContain("border-l");
  });
});
