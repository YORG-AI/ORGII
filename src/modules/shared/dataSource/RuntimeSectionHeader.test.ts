import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeRefreshButton,
  RuntimeSectionHeader,
} from "./RuntimeSectionHeader";

describe("RuntimeSectionHeader", () => {
  it("uses the shared compact text-only refresh props with a hover surface", () => {
    const markup = renderToStaticMarkup(
      createElement(RuntimeRefreshButton, {
        label: "Refresh",
        onRefresh: vi.fn(),
        refreshing: false,
        dataTestId: "runtime-refresh",
      })
    );

    expect(markup).toContain('data-testid="runtime-refresh"');
    expect(markup).toContain("border-0 bg-transparent text-text-2");
    expect(markup).toContain("enabled:hover:bg-surface-hover");
    expect(markup).toContain("height:28px");
    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain("Refresh");
  });

  it("keeps title and actions on the shared heading row", () => {
    const markup = renderToStaticMarkup(
      createElement(
        RuntimeSectionHeader,
        {
          title: "Profile",
          headingLevel: "h2",
          dataTestId: "runtime-title",
        },
        createElement("span", null, "action")
      )
    );

    expect(markup).toContain('data-testid="runtime-title"');
    expect(markup).toContain("<h2");
    expect(markup).toContain("Profile");
    expect(markup).toContain("action");
  });
});
