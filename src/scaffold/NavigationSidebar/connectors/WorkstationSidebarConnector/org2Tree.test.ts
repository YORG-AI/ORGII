import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { buildOrg2TreeItems } from "./index";
import { buildSessionRowActions } from "./sessionRowActions";

describe("buildOrg2TreeItems", () => {
  it("按 workspace→project→session 归组，Work Item 仅作为可选 metadata", () => {
    const tree = buildOrg2TreeItems([
      {
        session_id: "s1",
        name: "S1",
        projectSlug: "proj-a",
        workItemId: "T-1",
      },
      {
        session_id: "s2",
        name: "S2",
        projectSlug: "proj-a",
        workItemId: "T-2",
      },
      { session_id: "s3", name: "S3" },
    ] as never);
    const workspace = tree[0];
    expect(workspace.label).toBe("工作区层级");
    const project = workspace.children?.find((item) => item.label === "proj-a");
    expect(project?.children?.map((item) => item.label)).toEqual(["S1", "S2"]);
    expect(project?.children?.[0]?.id).toBe("s1");
    expect(project?.children?.[0]?.shortcut).toBe("工作项：T-1");
    const unlinked = workspace.children?.find(
      (item) => item.label === "Unlinked"
    );
    expect(unlinked?.children?.[0]?.label).toBe("S3");
  });

  it("树内 session 行复用普通 session 行动作：时间 + 置顶/标记 + 更多操作", () => {
    const [workspace] = buildOrg2TreeItems([
      { session_id: "s1", name: "S1", updated_at: "2026-07-06T10:00:00Z" },
    ] as never);
    const sessionItem = workspace.children?.[0]?.children?.[0] as
      | NavigationMenuItem
      | undefined;
    expect(sessionItem?.shortcut).toBeTruthy();

    const rowActions = buildSessionRowActions({
      activeSessionMoreMenuId: "",
      expandedSubagentParentIds: new Set(),
      handleMenuItemContextMenu: vi.fn(async () => undefined),
      handleTogglePin: vi.fn(),
      handleToggleSubagentExpansion: vi.fn(),
      item: sessionItem!,
      session: { session_id: "s1", pinned: false } as never,
      setActiveSessionMoreMenuId: vi.fn() as never,
      subagentParentIds: new Set(),
      tCommon: (_key, defaultValue) => defaultValue ?? "More actions",
      pinLabel: "Pin",
      unpinLabel: "Unpin",
    });

    expect(rowActions.map((action) => action.label)).toEqual([
      "Pin",
      "More actions",
    ]);
  });
});
