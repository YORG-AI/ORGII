import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session, SessionListCategory } from "@src/store/session";

import {
  buildByAgentMenuItems,
  buildByTimeMenuItems,
  buildByWorkspaceMenuItems,
} from "../menuSectionBuilders";

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
  return {
    id: `load-more-${category}`,
    key: `load-more-${category}`,
    label: "Load more",
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
});
