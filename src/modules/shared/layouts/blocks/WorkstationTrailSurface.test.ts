import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkstationTrailSurface, {
  WORKSTATION_TRAIL_WIDTH,
  WorkstationTrailBody,
  WorkstationTrailHeader,
  WorkstationTrailIconButton,
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

  it("shares one direct scroll body below trail headers", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationTrailBody, null, "Rows")
    );

    expect(markup).toContain("min-h-0");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("scrollbar-hide");
  });
});
