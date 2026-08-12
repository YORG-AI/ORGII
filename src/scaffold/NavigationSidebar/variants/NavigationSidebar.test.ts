import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "../components/NavigationMenu/config";
import { WorkItemsSidebarSkeleton } from "../connectors/WorkstationSidebarConnector/WorkItemsSidebarSkeleton";
import NavigationSidebar from "./NavigationSidebar";

vi.mock("../SidebarBase", () => ({
  default: ({ children }: { children?: ReactNode }) =>
    createElement("aside", null, children),
}));

vi.mock("../components/NavigationMenu", () => ({
  default: ({ items }: { items: readonly NavigationMenuItem[] }) =>
    createElement(
      "div",
      null,
      items.map((item) =>
        createElement(
          "span",
          { key: item.key, "data-test-menu-item": item.id },
          item.label
        )
      )
    ),
}));

describe("NavigationSidebar", () => {
  it("renders separators in pinned items as standard section headers", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationSidebar, {
        items: [],
        activeKey: "",
        onChange: vi.fn(),
        menuItems: [],
        pinnedMenuItems: [
          { id: "create", key: "create", label: "Create" },
          {
            id: "separator-work-items-browse",
            key: "separator-work-items-browse",
            label: "Browse",
          },
          { id: "projects", key: "projects", label: "Projects" },
        ],
      })
    );

    expect(markup).toContain(
      'class="mb-2 px-2 text-[11px] font-medium uppercase tracking-wider text-text-2">Browse</div>'
    );
    expect(markup).toContain('class="flex flex-col gap-3 px-3 pt-1"');
    expect(markup).toContain('data-sidebar-section-id="work-items-browse"');
    expect(markup).not.toContain(
      'data-test-menu-item="separator-work-items-browse"'
    );
  });

  it("allows titled pinned sections to be collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationSidebar, {
        items: [],
        activeKey: "",
        onChange: vi.fn(),
        menuItems: [],
        pinnedMenuItems: [
          { id: "create", key: "create", label: "Create" },
          {
            id: "separator-work-items-browse",
            key: "separator-work-items-browse",
            label: "Browse",
          },
          { id: "projects", key: "projects", label: "Projects" },
        ],
        collapsibleSections: true,
        collapsedSectionIds: new Set(["work-items-browse"]),
        onCollapsedSectionsChange: vi.fn(),
      })
    );

    expect(markup).toContain('data-sidebar-section-toggle="work-items-browse"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-test-menu-item="create"');
    expect(markup).not.toContain('data-test-menu-item="projects"');
  });

  it("renders surface-specific skeleton content while loading", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationSidebar, {
        items: [],
        activeKey: "",
        onChange: vi.fn(),
        menuItems: [],
        isLoading: true,
        loadingContent: createElement(WorkItemsSidebarSkeleton, {
          loadingLabel: "Loading work items",
        }),
      })
    );

    expect(markup).toContain('data-testid="work-items-sidebar-skeleton"');
    expect(markup).toContain('aria-label="Loading work items"');
    expect(markup).toContain("animate-pulse");
  });
});
