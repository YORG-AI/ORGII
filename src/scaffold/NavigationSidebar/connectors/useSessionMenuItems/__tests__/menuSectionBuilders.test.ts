import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  type Session,
  type SessionListCategory,
  type SessionPaginationScope,
  sessionPaginationScopeKey,
} from "@src/store/session";

import {
  buildByAgentMenuItems,
  buildByTimeMenuItems,
  buildByWorkspaceMenuItems,
} from "../menuSectionBuilders";

const PERSONAL_ORG_IDS = ["personal-org"] as const;

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

function appendAllGroupSessions(
  items: NavigationMenuItem[],
  groupSessions: readonly Session[]
): void {
  items.push(
    ...groupSessions.map((session) => ({
      id: session.session_id,
      key: session.session_id,
      label: session.session_id,
    }))
  );
}

function scopedLoadMoreRowFor(
  scope: SessionPaginationScope
): NavigationMenuItem {
  const scopeKey = sessionPaginationScopeKey(scope);
  return {
    id: `load-more-scope-${scopeKey}`,
    key: `load-more-scope-${scopeKey}`,
    label: "Load more",
  };
}

function getLoadMoreItemIds(items: readonly NavigationMenuItem[]): string[] {
  return items
    .map((item) => item.id)
    .filter((id) => id.startsWith("load-more"));
}

function scopeLoadMoreId(scope: SessionPaginationScope): string {
  return `load-more-scope-${sessionPaginationScopeKey(scope)}`;
}

function categoryLoadMoreId(category: SessionListCategory): string {
  return scopeLoadMoreId({
    kind: "category",
    category,
    orgIds: PERSONAL_ORG_IDS,
  });
}

describe("session menu section builders", () => {
  it("appends a backend load-more row scoped to its date group", () => {
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
      scopedLoadMoreRowFor: (scope) =>
        scope.kind === "time" && scope.bucket === "today"
          ? scopedLoadMoreRowFor(scope)
          : null,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      scopeLoadMoreId({
        kind: "time",
        bucket: "today",
        orgIds: PERSONAL_ORG_IDS,
      }),
    ]);
  });

  it("appends a backend load-more row scoped to its exact workspace", () => {
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
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
      workspaceFacets: [],
      workspaceFacetLoadMoreRow: null,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      scopeLoadMoreId({
        kind: "workspace",
        repoPath: "/workspace/orgii",
        orgIds: PERSONAL_ORG_IDS,
      }),
    ]);
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
      scopedLoadMoreRowFor: (scope) =>
        scope.kind === "time" && scope.bucket === "today"
          ? scopedLoadMoreRowFor(scope)
          : null,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      `load-more-group-${sessionPaginationScopeKey({
        kind: "time",
        bucket: "today",
        orgIds: PERSONAL_ORG_IDS,
      })}`,
    ]);
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
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
      workspaceFacets: [],
      workspaceFacetLoadMoreRow: null,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      `load-more-group-${sessionPaginationScopeKey({
        kind: "workspace",
        repoPath: "/workspace/orgii",
        orgIds: PERSONAL_ORG_IDS,
      })}`,
    ]);
  });

  it("renders an old-only workspace facet before any session row is hydrated", () => {
    const items = buildByWorkspaceMenuItems({
      unpinnedSessions: [],
      repoPathToName: new Map([["/workspace/old-only", "Old Only"]]),
      noWorkspaceLabel: "No Workspace",
      appendPinnedSessions,
      appendGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
      workspaceFacets: [
        {
          repoPath: "/workspace/old-only",
          lastUpdatedAtMs: 1,
          sessionCount: 1,
        },
      ],
      workspaceFacetLoadMoreRow: null,
    });

    expect(items.map((item) => item.label)).toEqual(["Old Only", "Load more"]);
    expect(getLoadMoreItemIds(items)).toEqual([
      scopeLoadMoreId({
        kind: "workspace",
        repoPath: "/workspace/old-only",
        orgIds: PERSONAL_ORG_IDS,
      }),
    ]);
  });

  it("keeps scoped pages revealed across consecutive By Time loads", () => {
    const today = new Date().toISOString();
    const sessions = Array.from({ length: 30 }, (_, index) =>
      makeSession(`sdeagent-${index}`, today)
    );
    const buildWithVisibleCount = (
      visibleCount: number,
      hasBackendPage: boolean
    ) =>
      buildByTimeMenuItems({
        unpinnedSessions: sessions.slice(0, visibleCount),
        dateGroupLabels: {
          today: "Today",
          yesterday: "Yesterday",
          thisWeek: "This Week",
          older: "Older",
        },
        appendPinnedSessions,
        appendGroupSessions: (items, groupId, groupSessions) => {
          items.push(
            ...groupSessions.slice(0, visibleCount).map((session) => ({
              id: session.session_id,
              key: session.session_id,
              label: session.session_id,
            }))
          );
          return false;
        },
        scopedLoadMoreRowFor: (scope) =>
          hasBackendPage && scope.kind === "time" && scope.bucket === "today"
            ? scopedLoadMoreRowFor(scope)
            : null,
        orgIds: PERSONAL_ORG_IDS,
      });

    for (const [visibleCount, hasBackendPage] of [
      [10, true],
      [20, true],
      [30, false],
    ] as const) {
      const items = buildWithVisibleCount(visibleCount, hasBackendPage);
      expect(
        items.filter((item) => item.id.startsWith("sdeagent-"))
      ).toHaveLength(visibleCount);
      expect(getLoadMoreItemIds(items)).toEqual(
        hasBackendPage
          ? [
              scopeLoadMoreId({
                kind: "time",
                bucket: "today",
                orgIds: PERSONAL_ORG_IDS,
              }),
            ]
          : []
      );
    }
  });

  it("renders all rows already fetched for a backend-paginated agent group", () => {
    const sessions = Array.from({ length: 11 }, (_, index) =>
      makeSession(`cursoride-${index}`, "2026-06-09T00:00:00.000Z")
    );

    const items = buildByAgentMenuItems({
      unpinnedSessions: sessions,
      pinnedSessions: [],
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      categoryLoadMoreId("external_history:cursor_ide"),
    ]);
    expect(
      items.filter((item) => item.id.startsWith("cursoride-"))
    ).toHaveLength(11);
  });

  it("appends the per-category backend load-more row in the by-agent view", () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      makeSession(`cursoride-${index}`, "2026-06-09T00:00:00.000Z")
    );

    const items = buildByAgentMenuItems({
      unpinnedSessions: sessions,
      pinnedSessions: [],
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      categoryLoadMoreId("external_history:cursor_ide"),
    ]);
  });

  it("does not let one group's local pagination suppress backend categories", () => {
    const sessions = [
      ...Array.from({ length: 11 }, (_, index) =>
        makeSession(`sdeagent-${index}`, "2026-06-09T00:00:00.000Z")
      ),
      makeSession("cliagent-root", "2026-06-08T00:00:00.000Z"),
    ];

    const items = buildByAgentMenuItems({
      unpinnedSessions: sessions,
      pinnedSessions: [],
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      categoryLoadMoreId("rust_agent:sde"),
      categoryLoadMoreId("cli_agent"),
    ]);
  });

  it("keeps an Agent Org local pager separate from the shared Rust backend pager", () => {
    const agentOrgSessions = Array.from({ length: 11 }, (_, index) => ({
      ...makeSession(`sdeagent-org-${index}`, "2026-06-09T00:00:00.000Z"),
      agentOrgId: "org-alpha",
      agentOrgName: "Alpha Org",
    }));
    const items = buildByAgentMenuItems({
      unpinnedSessions: [
        ...agentOrgSessions,
        makeSession("sdeagent-standalone", "2026-06-08T00:00:00.000Z"),
      ],
      pinnedSessions: [],
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      categoryLoadMoreId("rust_agent:agent_org"),
      categoryLoadMoreId("rust_agent:sde"),
    ]);
    const ids = items.map((item) => item.id);
    expect(
      ids.indexOf(categoryLoadMoreId("rust_agent:agent_org"))
    ).toBeGreaterThan(ids.indexOf("sdeagent-org-10"));
  });

  it("renders one Rust backend pager after OS, SDE and Wingman local pagers", () => {
    const sessions = [
      ...Array.from({ length: 11 }, (_, index) =>
        makeSession(`osagent-${index}`, "2026-06-09T00:00:00.000Z")
      ),
      ...Array.from({ length: 11 }, (_, index) =>
        makeSession(`sdeagent-${index}`, "2026-06-08T00:00:00.000Z")
      ),
      ...Array.from({ length: 11 }, (_, index) =>
        makeSession(`wingman-${index}`, "2026-06-07T00:00:00.000Z")
      ),
    ];
    const items = buildByAgentMenuItems({
      unpinnedSessions: sessions,
      pinnedSessions: [],
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      categoryLoadMoreId("rust_agent:os"),
      categoryLoadMoreId("rust_agent:sde"),
      categoryLoadMoreId("rust_agent:wingman"),
    ]);
    const ids = items.map((item) => item.id);
    expect(ids.indexOf(categoryLoadMoreId("rust_agent:sde"))).toBeGreaterThan(
      ids.indexOf("sdeagent-10")
    );
  });

  it("does not let pinned-session pagination suppress category pagination", () => {
    const appendHiddenPinnedSessions = (
      items: NavigationMenuItem[]
    ): boolean => {
      items.push({
        id: "load-more-group-pinned",
        key: "load-more-group-pinned",
        label: "Load more",
      });
      return true;
    };

    const items = buildByAgentMenuItems({
      unpinnedSessions: [
        makeSession("cliagent-root", "2026-06-08T00:00:00.000Z"),
      ],
      pinnedSessions: [],
      appendPinnedSessions: appendHiddenPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      "load-more-group-pinned",
      categoryLoadMoreId("cli_agent"),
    ]);
  });

  it("keeps evidence-backed category pagers when the loaded head is entirely pinned", () => {
    const pinnedAgentOrg = {
      ...makeSession("sdeagent-org-pinned", "2026-06-09T00:00:00.000Z"),
      pinned: true,
      agentOrgId: "org-alpha",
      agentOrgName: "Alpha Org",
    };
    const items = buildByAgentMenuItems({
      unpinnedSessions: [],
      pinnedSessions: [
        {
          ...makeSession("sdeagent-pinned", "2026-06-09T00:00:00.000Z"),
          pinned: true,
        },
        pinnedAgentOrg,
        {
          ...makeSession("cliagent-pinned", "2026-06-09T00:00:00.000Z"),
          pinned: true,
        },
        // Imported history has no authoritative pin field; this must not
        // invent a provider section even if a stale frontend object says so.
        {
          ...makeSession("codexapp-pinned", "2026-06-09T00:00:00.000Z"),
          pinned: true,
        },
      ],
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      orgIds: PERSONAL_ORG_IDS,
    });

    expect(getLoadMoreItemIds(items)).toEqual([
      categoryLoadMoreId("rust_agent:agent_org"),
      categoryLoadMoreId("rust_agent:sde"),
      categoryLoadMoreId("cli_agent"),
    ]);
    expect(items.some((item) => item.label === "Alpha Org")).toBe(true);
    expect(
      getLoadMoreItemIds(items).some((id) => id.includes("codex_app"))
    ).toBe(false);
  });
});
