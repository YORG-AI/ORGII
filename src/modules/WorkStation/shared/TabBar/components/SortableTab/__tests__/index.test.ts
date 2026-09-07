import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import { SortableTab, resolveWorkstationTabIntegrationIcon } from "..";
import { WorkstationTabContent } from "../../WorkstationTabContent";

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type, size }: { type: string; size: number }) =>
    createElement("span", {
      "data-integration-icon": type,
      "data-icon-size": size,
    }),
}));

function tab(
  type: WorkStationTab["type"],
  data: Record<string, unknown> = {}
): WorkStationTab {
  return { id: `test:${type}`, type, title: "Test", data };
}

describe("resolveWorkstationTabIntegrationIcon", () => {
  it("uses GitHub for native GitHub issue tabs", () => {
    expect(
      resolveWorkstationTabIntegrationIcon(tab("github-issue-detail"))
    ).toBe("github");
  });

  it("uses GitHub for imported GitHub work item tabs", () => {
    expect(
      resolveWorkstationTabIntegrationIcon(
        tab("workItem-detail", { workItemStatus: "open" })
      )
    ).toBe("github");
  });

  it("keeps native work item tabs on their existing icon path", () => {
    expect(
      resolveWorkstationTabIntegrationIcon(
        tab("workItem-detail", { workItemStatus: "planned" })
      )
    ).toBeNull();
  });

  it("keeps GitHub issue tabs within the regular width cap", () => {
    const markup = renderToStaticMarkup(
      createElement(SortableTab, {
        tab: {
          ...tab("github-issue-detail"),
          title: "A very long GitHub issue title that should truncate",
        },
        isActive: true,
        isDraggable: true,
        onTabClick: vi.fn(),
        onCloseClick: vi.fn(),
        onContextMenu: vi.fn(),
      })
    );

    expect(markup).toContain("max-w-[240px]");
    expect(markup).toContain("text-ellipsis");
    expect(markup).not.toContain("max-w-none");
  });

  it("uses text-1 for an active My Station tab and its monochrome icon", () => {
    const markup = renderToStaticMarkup(
      createElement(SortableTab, {
        tab: {
          ...tab("start"),
          icon: "LayoutGrid",
        },
        isActive: true,
        isDraggable: true,
        onTabClick: vi.fn(),
        onCloseClick: vi.fn(),
        onContextMenu: vi.fn(),
      })
    );
    const activeSurface = markup.match(
      /<div[^>]*work-station-editor-tab--active[^>]*>/
    )?.[0];

    expect(activeSurface).toContain("text-text-1");
    expect(activeSurface).not.toContain("text-primary-6");
    expect(markup).toMatch(
      /<svg[^>]*class="[^"]*text-text-1[^"]*"[^>]*data-icon="layout-grid"/
    );
  });
});

describe("Workstation tab drag content", () => {
  it("renders a tool glyph and localized label instead of the stored title", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationTabContent, {
        tab: {
          ...tab("start"),
          title: "Stale stored title",
          icon: "LayoutGrid",
        },
        isActive: true,
      })
    );

    expect(markup).toContain('data-icon="layout-grid"');
    expect(markup).toContain("navigation:routes.launchpad");
    expect(markup).not.toContain("Stale stored title");
  });

  it("preserves timeline revisions and the comparison glyph", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationTabContent, {
        tab: {
          ...tab("git-diff", {
            isTimeline: true,
            shortSha: "abc123",
            headShortSha: "def456",
          }),
          title: "index.ts",
        },
        isActive: false,
      })
    );

    expect(markup).toContain("index.ts (abc123)");
    expect(markup).toContain("(def456)");
    expect(markup).toContain('data-icon="move-horizontal"');
    expect(markup).toContain('data-icon="lock"');
    expect(markup).not.toContain("Working Tree");
  });
});
