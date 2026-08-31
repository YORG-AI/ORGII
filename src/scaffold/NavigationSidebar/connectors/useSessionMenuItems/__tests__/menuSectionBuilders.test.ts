import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session, SessionListCategory } from "@src/store/session";

import { NO_WORKSPACE_KEY } from "../../types";
import {
  buildByAgentMenuItems,
  buildByTimeMenuItems,
  buildByWorkspaceMenuItems,
} from "../menuSectionBuilders";
import type { WorkspaceGroupActions } from "../types";

function makeSession(
  sessionId: string,
  updatedAt: string,
  repoPath?: string
): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: updatedAt,
    updated_at: updatedAt,
    repoPath,
  };
}

function appendPinnedSessions(): boolean {
  return false;
}

function appendGroupSessions(
  items: NavigationMenuItem[],
  groupId: string,
  groupSessions: readonly Session[]
): boolean {
  const visibleSessions = groupSessions.slice(0, 10);
  items.push(
    ...visibleSessions.map((session) => ({
      id: session.session_id,
      key: session.session_id,
      label: session.session_id,
    }))
  );

  if (groupSessions.length <= 10) return false;

  items.push({
    id: `load-more-group-${groupId}`,
    key: `load-more-group-${groupId}`,
    label: "Load more",
  });
  return true;
}

function appendTrailingLoadMoreItems(items: NavigationMenuItem[]): void {
  items.push({
    id: "load-more-unified",
    key: "load-more-unified",
    label: "Load more",
  });
}

function loadMoreRowFor(
  category: SessionListCategory
): NavigationMenuItem | null {
  if (category !== "external_history:cursor_ide") return null;
  return {
    id: `load-more-${category}`,
    key: `load-more-${category}`,
    label: "Load more",
  };
}

function getSeparatorIds(items: readonly NavigationMenuItem[]): string[] {
  return items
    .map((item) => item.id)
    .filter((id) => id.startsWith("separator-"))
    .map((id) => id.slice("separator-".length));
}

function workspaceActions(
  overrides: Partial<WorkspaceGroupActions> = {}
): WorkspaceGroupActions {
  return {
    pinnedWorkspaceKeys: new Set<string>(),
    hiddenWorkspaceKeys: new Set<string>(),
    onCreateSession: () => undefined,
    onOpenMenu: () => undefined,
    createSessionLabel: "New session",
    moreActionsLabel: "More actions",
    ...overrides,
  };
}

function getLoadMoreItemIds(items: readonly NavigationMenuItem[]): string[] {
  return items
    .map((item) => item.id)
    .filter((id) => id.startsWith("load-more"));
}

describe("session menu section builders", () => {
  it("appends one unified backend load-more row in the by-time view", () => {
    const today = new Date().toISOString();
    const items = buildByTimeMenuItems({
      unpinnedSessions: [makeSession("cursoride-1", today)],
      dateGroupLabels: {
        today: "Today",
        yesterday: "Yesterday",
        thisWeek: "This Week",
        older: "Older",
      },
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    });

    expect(getLoadMoreItemIds(items)).toEqual(["load-more-unified"]);
  });

  it("appends one unified backend load-more row in the by-workspace view", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession(
          "cursoride-1",
          "2026-06-09T00:00:00.000Z",
          "/workspace/orgii"
        ),
      ],
      repoPathToName: new Map([["/workspace/orgii", "ORGII"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    });

    expect(getLoadMoreItemIds(items)).toEqual(["load-more-unified"]);
  });

  it("does not append a backend load-more row when a time group has local hidden sessions", () => {
    // Use the current day so the sessions always land in the "today" group
    // regardless of when the suite runs (a fixed past date would drift into
    // "older" over time and break this assertion).
    const today = new Date().toISOString();
    const sessions = Array.from({ length: 11 }, (_, index) =>
      makeSession(`cursoride-${index}`, today)
    );

    const items = buildByTimeMenuItems({
      unpinnedSessions: sessions,
      dateGroupLabels: {
        today: "Today",
        yesterday: "Yesterday",
        thisWeek: "This Week",
        older: "Older",
      },
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    });

    expect(getLoadMoreItemIds(items)).toEqual(["load-more-group-time:today"]);
  });

  it("does not append a backend load-more row when a workspace group has local hidden sessions", () => {
    const sessions = Array.from({ length: 11 }, (_, index) =>
      makeSession(
        `cursoride-${index}`,
        "2026-06-09T00:00:00.000Z",
        "/workspace/orgii"
      )
    );

    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: sessions,
      repoPathToName: new Map([["/workspace/orgii", "ORGII"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      "load-more-group-workspace:/workspace/orgii",
    ]);
  });

  it("does not append a backend load-more row below an agent group with local hidden sessions", () => {
    const sessions = Array.from({ length: 11 }, (_, index) =>
      makeSession(`cursoride-${index}`, "2026-06-09T00:00:00.000Z")
    );

    const items = buildByAgentMenuItems({
      unpinnedSessions: sessions,
      appendPinnedSessions,
      appendGroupSessions,
      loadMoreRowFor,
    });

    // Imported-history list categories are namespaced
    // (`external_history:<sourceId>`) since the loading consolidation.
    expect(getLoadMoreItemIds(items)).toEqual([
      "load-more-group-agent:external_history:cursor_ide",
    ]);
  });

  it("appends the per-category backend load-more row in the by-agent view", () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      makeSession(`cursoride-${index}`, "2026-06-09T00:00:00.000Z")
    );

    const items = buildByAgentMenuItems({
      unpinnedSessions: sessions,
      appendPinnedSessions,
      appendGroupSessions,
      loadMoreRowFor,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      "load-more-external_history:cursor_ide",
    ]);
  });

  it("uses one shared Standalone pager after SDE, Wingman, and Custom", () => {
    const items = buildByAgentMenuItems({
      unpinnedSessions: [
        makeSession("sdeagent-one", "2026-06-09T00:00:00.000Z"),
        makeSession("wingman-one", "2026-06-09T00:00:00.000Z"),
        makeSession("custom-one", "2026-06-09T00:00:00.000Z"),
      ],
      appendPinnedSessions,
      appendGroupSessions,
      loadMoreRowFor: (category) =>
        category === "standalone_agent"
          ? {
              id: "load-more-standalone_agent",
              key: "load-more-standalone_agent",
              label: "Load more",
            }
          : null,
    });

    expect(getLoadMoreItemIds(items)).toEqual(["load-more-standalone_agent"]);
    expect(items.map((item) => item.id)).toEqual([
      "separator-sde",
      "sdeagent-one",
      "separator-wingman",
      "wingman-one",
      "separator-custom",
      "custom-one",
      "load-more-standalone_agent",
    ]);
  });

  it("can render a Retry footer even when the failed stream has no rows", () => {
    const items = buildByAgentMenuItems({
      unpinnedSessions: [],
      appendPinnedSessions,
      appendGroupSessions,
      loadMoreRowFor: (category) =>
        category === "standalone_agent"
          ? {
              id: "load-more-standalone_agent",
              key: "load-more-standalone_agent",
              label: "Retry",
            }
          : null,
    });

    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["load-more-standalone_agent", "Retry"],
    ]);
  });

  it("places the Agent Org backend pager after all loaded Agent Org groups", () => {
    const rootA = {
      ...makeSession("sdeagent-org-a", "2026-06-09T00:00:00.000Z"),
      agentOrgId: "org-a",
      agentOrgName: "Alpha",
    };
    const rootB = {
      ...makeSession("sdeagent-org-b", "2026-06-10T00:00:00.000Z"),
      agentOrgId: "org-b",
      agentOrgName: "Beta",
    };

    const items = buildByAgentMenuItems({
      unpinnedSessions: [rootB, rootA],
      appendPinnedSessions,
      appendGroupSessions,
      loadMoreRowFor: (category) =>
        category === "agent_org_root"
          ? {
              id: "load-more-agent_org_root",
              key: "load-more-agent_org_root",
              label: "Load more",
            }
          : null,
    });

    expect(items.map((item) => item.id)).toEqual([
      "separator-agent-org:org-a",
      "sdeagent-org-a",
      "separator-agent-org:org-b",
      "sdeagent-org-b",
      "load-more-agent_org_root",
    ]);
  });

  it("does not infer Agent Org pagination ownership from pinned roots", () => {
    const items = buildByAgentMenuItems({
      unpinnedSessions: [],
      appendPinnedSessions: (target) => {
        target.push({
          id: "pinned-org-root",
          key: "pinned-org-root",
          label: "Pinned root",
        });
        return false;
      },
      appendGroupSessions,
      loadMoreRowFor: () => null,
    });

    expect(items.map((item) => item.id)).toEqual(["pinned-org-root"]);
  });

  it("buckets sessions without a workspace under the No Workspace group", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession("scratch-1", "2026-06-09T00:00:00.000Z"),
        makeSession("scratch-2", "2026-06-09T00:00:00.000Z", "   "),
        makeSession("real-1", "2026-06-09T00:00:00.000Z", "/workspace/orgii"),
      ],
      repoPathToName: new Map([["/workspace/orgii", "ORGII"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    });

    // One bucket for both workspace-less sessions, sorted after the named one.
    expect(getSeparatorIds(items)).toEqual([
      "/workspace/orgii",
      NO_WORKSPACE_KEY,
    ]);
  });

  it("sorts pinned workspace groups first and hidden ones last", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession("a", "2026-06-09T00:00:00.000Z", "/workspace/alpha"),
        makeSession("b", "2026-06-09T00:00:00.000Z", "/workspace/beta"),
        makeSession("c", "2026-06-09T00:00:00.000Z", "/workspace/zeta"),
        makeSession("d", "2026-06-09T00:00:00.000Z"),
      ],
      repoPathToName: new Map([
        ["/workspace/alpha", "Alpha"],
        ["/workspace/beta", "Beta"],
        ["/workspace/zeta", "Zeta"],
      ]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
      workspaceGroupActions: workspaceActions({
        pinnedWorkspaceKeys: new Set(["/workspace/zeta"]),
        hiddenWorkspaceKeys: new Set(["/workspace/alpha"]),
      }),
    });

    // Pinned Zeta jumps above alphabetically-earlier Beta; hidden Alpha sinks
    // below "No Workspace".
    expect(getSeparatorIds(items)).toEqual([
      "/workspace/zeta",
      "/workspace/beta",
      NO_WORKSPACE_KEY,
      "/workspace/alpha",
    ]);
  });

  it("marks pinned and hidden workspace headers with their state glyph", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession("a", "2026-06-09T00:00:00.000Z", "/workspace/alpha"),
        makeSession("b", "2026-06-09T00:00:00.000Z", "/workspace/beta"),
        makeSession("c", "2026-06-09T00:00:00.000Z", "/workspace/gamma"),
      ],
      repoPathToName: new Map([
        ["/workspace/alpha", "Alpha"],
        ["/workspace/beta", "Beta"],
        ["/workspace/gamma", "Gamma"],
      ]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
      workspaceGroupActions: workspaceActions({
        pinnedWorkspaceKeys: new Set(["/workspace/beta"]),
        hiddenWorkspaceKeys: new Set(["/workspace/gamma"]),
      }),
    });

    const glyphLabelFor = (key: string): unknown => {
      const element = items.find((item) => item.id === `separator-${key}`)
        ?.iconElement as { props?: { "aria-label"?: string } } | undefined;
      return element?.props?.["aria-label"];
    };

    // Position alone reads as "sorts first" / "sorts last"; the glyph is what
    // says the viewer put it there.
    expect(glyphLabelFor("/workspace/beta")).toBe("Pinned");
    expect(glyphLabelFor("/workspace/gamma")).toBe("Hidden");
    expect(glyphLabelFor("/workspace/alpha")).toBeUndefined();
  });

  it("lifts a pinned No Workspace group above the named workspaces", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession("a", "2026-06-09T00:00:00.000Z", "/workspace/alpha"),
        makeSession("b", "2026-06-09T00:00:00.000Z"),
      ],
      repoPathToName: new Map([["/workspace/alpha", "Alpha"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
      workspaceGroupActions: workspaceActions({
        pinnedWorkspaceKeys: new Set([NO_WORKSPACE_KEY]),
      }),
    });

    expect(getSeparatorIds(items)).toEqual([
      NO_WORKSPACE_KEY,
      "/workspace/alpha",
    ]);
  });

  it("puts the more-actions menu before the create action on each header", () => {
    const created: string[] = [];
    const opened: string[] = [];
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession("a", "2026-06-09T00:00:00.000Z", "/workspace/orgii"),
        makeSession("b", "2026-06-09T00:00:00.000Z"),
      ],
      repoPathToName: new Map([["/workspace/orgii", "ORGII"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
      workspaceGroupActions: workspaceActions({
        onCreateSession: (key) => created.push(key),
        onOpenMenu: (key) => opened.push(key),
      }),
    });

    const event = {} as React.MouseEvent<HTMLButtonElement>;

    const workspaceHeader = items.find(
      (item) => item.id === "separator-/workspace/orgii"
    );
    expect(
      workspaceHeader?.rowActions?.map((action) => action.dataTestId)
    ).toEqual([
      "sidebar-workspace-more-/workspace/orgii",
      "sidebar-workspace-new-session-/workspace/orgii",
    ]);
    workspaceHeader?.rowActions?.[0]?.onClick(event);
    workspaceHeader?.rowActions?.[1]?.onClick(event);
    expect(opened).toEqual(["/workspace/orgii"]);
    expect(created).toEqual(["/workspace/orgii"]);

    // "No Workspace" is not a directory, so it carries only the `…` menu.
    const noWorkspaceHeader = items.find(
      (item) => item.id === `separator-${NO_WORKSPACE_KEY}`
    );
    expect(noWorkspaceHeader?.rowActions).toHaveLength(1);
    noWorkspaceHeader?.rowActions?.[0]?.onClick(event);
    expect(opened).toEqual(["/workspace/orgii", NO_WORKSPACE_KEY]);
  });

  it("leaves workspace headers actionless when no actions are supplied", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [
        makeSession("a", "2026-06-09T00:00:00.000Z", "/workspace/orgii"),
      ],
      repoPathToName: new Map([["/workspace/orgii", "ORGII"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    });

    expect(
      items.find((item) => item.id === "separator-/workspace/orgii")?.rowActions
    ).toBeUndefined();
  });
});
