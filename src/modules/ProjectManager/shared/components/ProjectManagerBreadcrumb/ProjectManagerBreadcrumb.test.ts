import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ProjectManagerBreadcrumb, { truncateProjectManagerHeaderLabel } from ".";

describe("ProjectManagerBreadcrumb", () => {
  it("truncates labels to the requested character count", () => {
    const result = truncateProjectManagerHeaderLabel("a".repeat(50), 40);

    expect(result).toBe(`${"a".repeat(39)}…`);
    expect(Array.from(result)).toHaveLength(40);
  });

  it("counts unicode code points instead of UTF-16 units", () => {
    expect(truncateProjectManagerHeaderLabel("🚀🚀🚀", 2)).toBe("🚀…");
  });

  it("uses 24/36 character limits for two-level breadcrumbs", () => {
    const parentLabel = "p".repeat(30);
    const leafLabel = "w".repeat(45);
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [
          { label: parentLabel, onClick: vi.fn() },
          { label: leafLabel },
        ],
      })
    );

    expect(markup).toContain(`${"p".repeat(23)}…`);
    expect(markup).toContain(`${"w".repeat(35)}…`);
    expect(markup).toContain('role="button"');
  });

  it("keeps labels containing slashes as one display segment", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [{ label: "Research/Planning" }, { label: "Roadmap" }],
      })
    );

    expect(markup).toContain(">Research/Planning</span>");
  });

  it("renders a supplied identity icon only on the first segment", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [
          { label: "Parent" },
          {
            label: "Child",
            icon: React.createElement("span", { "data-header-icon": true }),
          },
        ],
      })
    );

    expect(markup.match(/data-header-icon/g)).toHaveLength(1);
    expect(markup.indexOf("data-header-icon")).toBeLessThan(
      markup.indexOf(">Parent</span>")
    );
  });
});
