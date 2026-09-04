import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "../components/NavigationMenu/config";
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
      'class="mb-2 flex items-center gap-1.5 px-2 text-[11px] font-medium tracking-wider text-text-2 uppercase"'
    );
    expect(markup).toContain('<span class="min-w-0 truncate">Browse</span>');
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

  it("renders actions on an existing session section header", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationSidebar, {
        items: [],
        activeKey: "",
        onChange: vi.fn(),
        menuItems: [
          {
            id: "separator-today",
            key: "separator-today",
            label: "Today",
            rowActions: [
              {
                label: "Search sessions",
                dataTestId: "sidebar-sessions-search",
                onClick: vi.fn(),
              },
              {
                label: "Refresh",
                dataTestId: "sidebar-sessions-refresh",
                onClick: vi.fn(),
              },
            ],
          },
          { id: "session-1", key: "session-1", label: "First session" },
        ],
        collapsibleSections: true,
      })
    );

    expect(markup).toContain('data-sidebar-section-toggle="today"');
    expect(markup).toContain(">Today</span>");
    expect(markup).toContain('data-testid="sidebar-sessions-search"');
    expect(markup).toContain('title="Search sessions"');
    expect(markup).toContain('data-testid="sidebar-sessions-refresh"');
    expect(markup).toContain('title="Refresh"');
    expect(
      markup.indexOf('data-testid="sidebar-sessions-search"')
    ).toBeLessThan(markup.indexOf('data-testid="sidebar-sessions-refresh"'));
  });

  it("autofocuses inline search while keeping fixed navigation visible", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationSidebar, {
        items: [],
        activeKey: "",
        onChange: vi.fn(),
        pinnedMenuItems: [
          { id: "new-session", key: "new-session", label: "New session" },
        ],
        menuItems: [
          {
            id: "separator-today",
            key: "separator-today",
            label: "Today",
          },
          { id: "match", key: "match", label: "Matching session" },
          { id: "other", key: "other", label: "Unrelated task" },
        ],
        search: {
          value: "matching",
          onChange: vi.fn(),
          placeholder: "Search sessions...",
          autoFocus: true,
          filterPinnedItems: false,
        },
      })
    );

    expect(markup).toContain('placeholder="Search sessions..."');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('data-test-menu-item="new-session"');
    expect(markup).toContain('data-test-menu-item="match"');
    expect(markup).not.toContain('data-test-menu-item="other"');
  });

  it("renders the standard loading state without dummy rows", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationSidebar, {
        items: [],
        activeKey: "",
        onChange: vi.fn(),
        menuItems: [],
        isLoading: true,
      })
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("animate-pulse");
  });
});
