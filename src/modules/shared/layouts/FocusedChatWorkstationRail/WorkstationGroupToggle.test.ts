import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkstationGroupToggle } from "./WorkstationGroupToggle";

describe("WorkstationGroupToggle", () => {
  it("uses chevron-down to collapse an expanded group", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationGroupToggle, {
        collapseLabel: "Collapse",
        collapsed: false,
        expandLabel: "Expand",
        groupKey: "workspace",
        onToggle: () => {},
      })
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-icon="chevron-down"');
    expect(markup).toContain('data-workstation-group-toggle="workspace"');
    expect(markup).toContain("group-hover/workstation-trail:opacity-100");
  });

  it("uses chevron-right to expand a collapsed group", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationGroupToggle, {
        collapseLabel: "Collapse",
        collapsed: true,
        expandLabel: "Expand",
        groupKey: "tabs",
        onToggle: () => {},
      })
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-icon="chevron-right"');
    expect(markup).toContain('data-workstation-group-toggle="tabs"');
  });
});
