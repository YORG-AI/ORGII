import { describe, expect, it } from "vitest";

import type { Session } from "../..";
import {
  type SessionPaginationMap,
  resetPaginationState,
} from "../paginationAtoms";
import {
  createSidebarRosterMatcher,
  sidebarCategoryForSession,
  syncSessionWithNativeRosters,
} from "../sidebarRoster";

function makeSession(
  sessionId: string,
  overrides: Partial<Session> = {}
): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: "2026-07-30T00:00:00Z",
    updated_at: "2026-07-30T00:00:00Z",
    ...overrides,
  };
}

function withStandaloneRoster(
  sessionIds: readonly string[],
  generation: number
): SessionPaginationMap {
  const pagination = resetPaginationState();
  return {
    ...pagination,
    standalone_agent: {
      ...pagination.standalone_agent,
      sessionIds,
      generation,
      phase: "ready",
      cursor: {
        updatedAt: "2026-07-30T00:00:00Z",
        sessionId: sessionIds.at(-1) ?? "none",
      },
    },
  };
}

describe("sidebar roster ownership", () => {
  it("shows cached rows provisionally, then trusts only the backend page", () => {
    const cached = Array.from({ length: 30 }, (_, index) =>
      makeSession(`sdeagent-${index + 1}`)
    );
    const provisionalMatcher = createSidebarRosterMatcher(
      withStandaloneRoster([], 0)
    );
    expect(cached.filter(provisionalMatcher)).toHaveLength(30);

    const authoritativeMatcher = createSidebarRosterMatcher(
      withStandaloneRoster(
        cached.slice(0, 10).map((session) => session.session_id),
        1
      )
    );
    expect(cached.filter(authoritativeMatcher)).toHaveLength(10);
  });

  it("keeps imported history out of native Pinned ownership", () => {
    expect(
      sidebarCategoryForSession(
        makeSession("codexapp-history", {
          category: "external_history",
          pinned: true,
        })
      )
    ).toBe("external_history:codex_app");
    expect(
      sidebarCategoryForSession(
        makeSession("cliagent-native", {
          category: "cli_agent",
          pinned: true,
        })
      )
    ).toBe("pinned_native");
  });

  it("renders pin state immediately without rewriting either stream cursor", () => {
    const cursor = {
      updatedAt: "2026-07-30T00:00:00Z",
      sessionId: "sdeagent-10",
    };
    const base = resetPaginationState();
    const pagination: SessionPaginationMap = {
      ...base,
      pinned_native: {
        ...base.pinned_native,
        sessionIds: [],
        cursor,
        generation: 1,
      },
      standalone_agent: {
        ...base.standalone_agent,
        sessionIds: ["sdeagent-10"],
        cursor,
        generation: 1,
      },
    };

    const pinned = syncSessionWithNativeRosters(
      pagination,
      makeSession("sdeagent-10", { pinned: true })
    );
    expect(pinned.pinned_native.sessionIds).toEqual([]);
    expect(pinned.standalone_agent.sessionIds).toEqual(["sdeagent-10"]);
    expect(pinned.pinned_native.cursor).toEqual(cursor);
    expect(pinned.standalone_agent.cursor).toEqual(cursor);
    expect(
      createSidebarRosterMatcher(pinned)(
        makeSession("sdeagent-10", { pinned: true })
      )
    ).toBe(true);

    const unpinned = syncSessionWithNativeRosters(
      pinned,
      makeSession("sdeagent-10", { pinned: false })
    );
    expect(unpinned.pinned_native.sessionIds).toEqual([]);
    expect(unpinned.standalone_agent.sessionIds).toEqual(["sdeagent-10"]);
    expect(
      createSidebarRosterMatcher(unpinned)(
        makeSession("sdeagent-10", { pinned: false })
      )
    ).toBe(true);
  });
});
