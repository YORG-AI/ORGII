import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DetailTabStrip from "./DetailTabStrip";

describe("DetailTabStrip", () => {
  it("links tabs to their panels and renders optional counts", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailTabStrip, {
        activeTab: "list",
        ariaLabel: "Project views",
        idPrefix: "project-detail",
        onChange: vi.fn(),
        tabs: [
          { key: "overview", label: "Overview" },
          { key: "list", label: "List", count: 3 },
        ],
      })
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Project views"');
    expect(markup).toContain('id="project-detail-tab-list"');
    expect(markup).toContain('aria-controls="project-detail-tabpanel-list"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain(">3</span>");
    expect(markup).toMatch(/role="tablist"[^>]*border-b/);
    expect(markup).toMatch(
      /aria-selected="true"[^>]*after:-bottom-px[^>]*after:bg-bg-2/
    );
    expect(markup).toMatch(/aria-selected="true"[^>]*border-b-bg-2/);
    expect(markup).not.toContain("overflow-y-hidden");
  });

  it("renders a count label that communicates a capped result", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailTabStrip, {
        activeTab: "changes",
        ariaLabel: "Pull request views",
        idPrefix: "pr-detail",
        onChange: vi.fn(),
        tabs: [{ key: "changes", label: "Files changed", count: "3000+" }],
      })
    );

    expect(markup).toContain(">3000+</span>");
  });

  it("keeps host controls in a trailing slot", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailTabStrip, {
        activeTab: "overview",
        ariaLabel: "Project views",
        idPrefix: "project-detail",
        onChange: vi.fn(),
        tabs: [{ key: "overview", label: "Overview" }],
        trailing: createElement("button", { type: "button" }, "Filter"),
      })
    );

    expect(markup).toContain(">Filter</button>");
    expect(markup).toMatch(/role="tablist"[^>]*\bpl-3\b[^>]*\bpr-\[7px\]/);
  });

  it("embeds tabs in a header without creating another bordered row", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailTabStrip, {
        activeTab: "overview",
        ariaLabel: "Project views",
        idPrefix: "project-detail",
        onChange: vi.fn(),
        tabs: [{ key: "overview", label: "Overview" }],
        variant: "header",
      })
    );

    expect(markup).toContain("h-10 min-w-0");
    expect(markup).not.toContain("pr-[7px]");
    expect(markup).not.toContain("overflow-x-auto");
    expect(markup).not.toMatch(/role="tablist"[^>]*border-b/);
    expect(markup).toMatch(
      /aria-selected="true"[^>]*after:-bottom-px[^>]*after:bg-bg-2/
    );
    expect(markup).toMatch(/aria-selected="true"[^>]*border-b-bg-2/);
  });
});
