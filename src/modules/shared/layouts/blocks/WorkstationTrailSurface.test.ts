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
    // The focused-chat column is resizable, so its width and the trail
    // surface's own width come from custom properties instead of fixed
    // Tailwind widths — and they are separate, because the docked terminal
    // can widen the column without widening the trail.
    expect(WORKSTATION_TRAIL_WIDTH.resizableResponsiveClass).toContain(
      "w-(--workstation-trail-track-width)"
    );
    expect(WORKSTATION_TRAIL_WIDTH.surfaceResponsiveClass).toContain(
      "w-(--workstation-trail-width)"
    );
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
    expect(markup).toContain("shadow-dropdown-soft");
    expect(markup).toContain("bg-(--cm-editor-background)");
    expect(markup).not.toContain("bg-bg-1/90");
  });

  it("shares the exact title row and collapse-button geometry", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationTrailHeader, {
        title: "Environment",
        titleActions: createElement(
          WorkstationTrailIconButton,
          { "aria-label": "Collapse groups" },
          "up/down"
        ),
        actions: createElement(
          WorkstationTrailIconButton,
          { "aria-label": "Collapse" },
          ">>"
        ),
      })
    );

    expect(markup).toContain("mb-1");
    expect(markup).toContain("h-6");
    expect(markup).toContain("justify-between pr-[3px] pl-1");
    expect(markup).toContain("pr-[3px]");
    expect(markup).toContain("px-1 text-[11px]");
    expect(markup).toContain("uppercase tracking-wide");
    expect(markup).toContain("Collapse groups");
    expect(markup).toContain("flex min-w-0 flex-1 items-center");
    expect(markup).toContain("h-5 w-5");
    expect(markup).toContain("items-center gap-px");
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
    expect(markup).toContain("flex h-6 items-center justify-between");
    expect(markup).toContain("gap-2");
    expect(markup).not.toContain("pr-1");

    const noActionMarkup = renderToStaticMarkup(
      createElement(WorkstationTrailSection, { title: "Labels" }, "Chips")
    );
    // Actionless sections keep the same label row, so every section title in a
    // rail sits on one baseline.
    expect(noActionMarkup).toContain("<h3");
    expect(noActionMarkup).toContain("flex h-6 items-center");
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
