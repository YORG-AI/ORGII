import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ProjectsPageHeader from ".";

const publishWorkstationHeader = vi.hoisted(() => vi.fn());

vi.mock("@src/hooks/tabHost/useWorkstationTabHeader", () => ({
  usePublishWorkstationTabHeader: publishWorkstationHeader,
}));

describe("ProjectsPageHeader", () => {
  it("uses the sidebar's collection icon for the Projects index", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectsPageHeader, { title: "Projects" })
    );

    expect(markup).toContain('data-icon="box"');
    expect(markup).toContain("h-9");
    expect(markup).not.toContain("h-[40px]");
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
    expect(markup).not.toContain('data-icon="box"');
    expect(markup).not.toContain(">Projects</span>");
  });

  it("uses the shared refresh action and square-pen create action", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectsPageHeader, {
        title: "Projects",
        onRefresh: vi.fn(),
        onAddProject: vi.fn(),
      })
    );

    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain('data-icon="square-pen"');
    expect(markup).not.toContain('data-icon="plus"');
  });

  it("keeps Work Management controls in a dedicated 36px surface row", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectsPageHeader, {
        title: "Projects",
        breadcrumbSegments: [],
        publishToWorkstationHeader: true,
        surfaceOwnedHeader: true,
        surfaceHeaderLeading: React.createElement(
          "button",
          { "data-testid": "work-dataset-projects" },
          "Projects"
        ),
        leadingControls: React.createElement(
          "button",
          { "data-testid": "group-projects" },
          "Status"
        ),
        trailingControls: React.createElement(
          "span",
          { "data-testid": "projects-search" },
          "Search"
        ),
      })
    );

    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).toContain('data-split-list-header-row="primary"');
    expect(markup).toContain('data-testid="work-dataset-projects"');
    expect(markup).toContain('data-testid="group-projects"');
    expect(markup).toContain('data-testid="projects-search"');
    expect(markup).toContain("h-9");
    expect(markup).not.toContain("h-[40px]");
    expect(publishWorkstationHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: { hidden: true },
        enabled: true,
        host: "project",
      })
    );
  });
});
