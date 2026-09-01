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
    expect(markup).toContain("hover:underline hover:decoration-text-1");
    expect(markup).toContain("mx-0 shrink-0 text-fill-4");
  });

  it("keeps a fill-width segment untruncated", () => {
    const leafLabel = "GitHub issue title ".repeat(4).trim();
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [
          { label: "ORGII issues", onClick: vi.fn() },
          { label: leafLabel, fillAvailableWidth: true },
        ],
      })
    );

    expect(markup).toContain(leafLabel);
    expect(markup).not.toContain("GitHub issue title GitHub issue tit…");
    expect(markup).toContain("flex-1");
  });

  it("keeps labels containing slashes as one display segment", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [{ label: "Research/Planning" }, { label: "Roadmap" }],
      })
    );

    expect(markup).toContain(">Research/Planning</span>");
  });

  it("renders custom segment content while retaining the full label metadata", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [
          { label: "Project" },
          {
            label: "WI-0001 · Original title",
            content: React.createElement("input", {
              "aria-label": "Rename",
              value: "Original title",
              readOnly: true,
            }),
          },
        ],
      })
    );

    expect(markup).toContain('aria-label="Rename"');
    expect(markup).toContain('value="Original title"');
    expect(markup).toContain('title="WI-0001 · Original title"');
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

  it("uses one evenly spaced container for trailing header controls", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProjectManagerBreadcrumb, {
        segments: [{ label: "Projects" }],
        trailingNode: React.createElement(
          "div",
          { className: "contents" },
          React.createElement("button", null, "Filter"),
          React.createElement("button", null, "View")
        ),
      })
    );

    expect(markup).toContain(
      'class="inline-flex h-6 shrink-0 items-center gap-2"'
    );
  });
});
