import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ProjectsPageHeader from ".";

describe("ProjectsPageHeader", () => {
  it("uses the sidebar's collection icon for the Projects index", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectsPageHeader, { title: "Projects" })
    );

    expect(markup).toContain('data-icon="boxes"');
    expect(markup).not.toMatch(/data-icon="box"/);
  });

  it("renders top-level project controls without a duplicate title", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectsPageHeader, {
        title: "Projects",
        breadcrumbSegments: [],
        leadingControls: React.createElement(
          "button",
          { "data-testid": "group-projects" },
          "Status"
        ),
      })
    );

    expect(markup).toContain('data-testid="group-projects"');
    expect(markup).toContain('class="contents"');
    expect(markup).not.toContain('data-icon="boxes"');
    expect(markup).not.toContain(">Projects</span>");
  });
});
