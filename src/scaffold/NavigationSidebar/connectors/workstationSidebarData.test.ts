import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { findSidebarSectionIdForMenuItem } from "./workstationSidebarData";

describe("findSidebarSectionIdForMenuItem", () => {
  it("resolves a historical session and nested child to their date section", () => {
    const items: NavigationMenuItem[] = [
      { id: "separator-today", key: "separator-today", label: "Today" },
      { id: "today", key: "today", label: "Today session" },
      { id: "separator-older", key: "separator-older", label: "Older" },
      {
        id: "parent",
        key: "parent",
        label: "Historical parent",
        children: [{ id: "child", key: "child", label: "Subagent" }],
      },
    ];

    expect(findSidebarSectionIdForMenuItem(items, "parent")).toBe("older");
    expect(findSidebarSectionIdForMenuItem(items, "child")).toBe("older");
    expect(findSidebarSectionIdForMenuItem(items, "missing")).toBeNull();
  });
});
