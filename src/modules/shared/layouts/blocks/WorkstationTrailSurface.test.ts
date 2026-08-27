import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkstationTrailSurface, {
  WORKSTATION_TRAIL_WIDTH,
  WorkstationTrailBody,
  WorkstationTrailEmptyText,
  WorkstationTrailHeader,
  WorkstationTrailIconButton,
  WorkstationTrailSection,
} from "./WorkstationTrailSurface";

describe("WorkstationTrailSurface", () => {
  it("owns the expanded Workstation trail width", () => {
    expect(WORKSTATION_TRAIL_WIDTH.expandedPx).toBe(256);
    expect(WORKSTATION_TRAIL_WIDTH.expandedResponsiveClass).toContain("w-64");
  });

  it("owns the exact focused-chat environment trail surface", () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkstationTrailSurface,
        { as: "aside", "aria-label": "Environment" },
        "Trail content"
      )
    );

    expect(markup).toContain("<aside");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("border-border-1");
    expect(markup).toContain("p-1");
    expect(markup).toContain("shadow-dropdown");
    expect(markup).toContain("bg-[var(--cm-editor-background)]");
    expect(markup).not.toContain("bg-bg-1/90");
  });

  it("shares the exact title row and collapse-button geometry", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationTrailHeader, {
        title: "Environment",
        actions: createElement(
          WorkstationTrailIconButton,
          { "aria-label": "Collapse" },
          ">>"
        ),
      })
    );

    expect(markup).toContain("mb-1");
    expect(markup).toContain("h-7");
    expect(markup).toContain("justify-between pl-1");
    expect(markup).toContain("px-1 text-[11px]");
    expect(markup).toContain("uppercase tracking-wide");
    expect(markup).toContain("h-[26px] w-[26px]");
    expect(markup).toContain("rounded-lg");
  });

  it("shares the labelled trail section used by property and detail rails", () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkstationTrailSection,
        {
          title: "Reviewers",
          dataTestId: "section",
          action: createElement("button", { type: "button" }, "Edit"),
        },
        createElement(WorkstationTrailEmptyText, null, "No reviews")
      )
    );

    expect(markup).toContain('data-testid="section"');
    expect(markup).toContain("<h3");
    expect(markup).toContain("uppercase tracking-wide");
    expect(markup).toContain("justify-between");
    expect(markup).toContain(">Edit</button>");
    expect(markup).toContain("text-text-3");
    expect(markup).toContain("No reviews");
    // A section action occupies the same row geometry as the trail header's
    // own control, so the two line up across surfaces.
    expect(markup).toContain("flex h-7 items-center justify-between");
    expect(markup).not.toContain("pr-1");

    const noActionMarkup = renderToStaticMarkup(
      createElement(WorkstationTrailSection, { title: "Labels" }, "Chips")
    );
    // Actionless sections keep the same label row, so every section title in a
    // rail sits on one baseline.
    expect(noActionMarkup).toContain("<h3");
    expect(noActionMarkup).toContain("flex h-7 items-center");
  });

  it("shares one direct scroll body below trail headers", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationTrailBody, null, "Rows")
    );

    expect(markup).toContain("min-h-0");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("scrollbar-hide");
  });
});
