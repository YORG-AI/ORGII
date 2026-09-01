import type React from "react";
import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { addActionsToFirstSessionSection } from "./sidebarMenuCollections";

describe("addActionsToFirstSessionSection", () => {
  it("adds search before refresh on the first regular session header only", () => {
    const onSearch = vi.fn();
    const onRefresh = vi.fn();
    const existingAction = vi.fn();
    const items: NavigationMenuItem[] = [
      {
        id: "separator-pinned",
        key: "separator-pinned",
        label: "Pinned",
      },
      { id: "session-pinned", key: "session-pinned", label: "Pinned session" },
      {
        id: "separator-today",
        key: "separator-today",
        label: "Today",
        rowActions: [{ label: "Existing", onClick: existingAction }],
      },
      { id: "session-1", key: "session-1", label: "First" },
      {
        id: "separator-yesterday",
        key: "separator-yesterday",
        label: "Yesterday",
      },
    ];

    const result = addActionsToFirstSessionSection({
      menuItems: items,
      searchLabel: "Search sessions",
      refreshLabel: "Refresh",
      refreshIconClassName: "animate-spin",
      onSearch,
      onRefresh,
    });

    expect(result[0]?.rowActions).toBeUndefined();
    expect(result[2]).toMatchObject({
      id: "separator-today",
      rowActions: [
        expect.objectContaining({
          label: "Search sessions",
          dataIcon: "search",
          dataTestId: "sidebar-sessions-search",
        }),
        expect.objectContaining({
          label: "Refresh",
          dataIcon: "refresh-cw",
          iconClassName: "animate-spin",
          dataTestId: "sidebar-sessions-refresh",
        }),
        expect.objectContaining({ label: "Existing" }),
      ],
    });
    expect(result[4]?.rowActions).toBeUndefined();

    result[2]?.rowActions?.[0]?.onClick(
      {} as React.MouseEvent<HTMLButtonElement>
    );
    expect(onSearch).toHaveBeenCalledOnce();
    result[2]?.rowActions?.[1]?.onClick(
      {} as React.MouseEvent<HTMLButtonElement>
    );
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps a pinned-only session list unchanged", () => {
    const items: NavigationMenuItem[] = [
      {
        id: "separator-pinned",
        key: "separator-pinned",
        label: "Pinned",
      },
      { id: "session-pinned", key: "session-pinned", label: "Pinned session" },
    ];

    expect(
      addActionsToFirstSessionSection({
        menuItems: items,
        searchLabel: "Search sessions",
        refreshLabel: "Refresh",
        onSearch: vi.fn(),
        onRefresh: vi.fn(),
      })
    ).toBe(items);
  });

  it("keeps a headerless session list unchanged", () => {
    const items: NavigationMenuItem[] = [
      { id: "session-1", key: "session-1", label: "First" },
    ];

    expect(
      addActionsToFirstSessionSection({
        menuItems: items,
        searchLabel: "Search sessions",
        refreshLabel: "Refresh",
        onSearch: vi.fn(),
        onRefresh: vi.fn(),
      })
    ).toBe(items);
  });
});
