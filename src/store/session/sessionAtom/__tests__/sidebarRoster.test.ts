import { beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../..";
import {
  type SessionPaginationMap,
  resetPaginationState,
} from "../paginationAtoms";
import {
  acknowledgeCreatedSessionsInNativeRoster,
  createSidebarRosterMatcher,
  registerCreatedSessionWithRoster,
  removeSessionFromRosters,
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
  beforeEach(() => {
    localStorage.removeItem("orgii:clientCreatedSessions:v1");
    localStorage.removeItem("orgii:guestShareImports:v1");
  });

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

  it("keeps confirmed local creations separate until the backend acknowledges them", () => {
    const cursor = {
      updatedAt: "2026-07-30T00:00:00Z",
      sessionId: "sdeagent-10",
    };
    const base = withStandaloneRoster(["sdeagent-10"], 1);
    const created = makeSession("sdeagent-created", {
      // A known creation must stay visible even when timestamp precision puts
      // it at or behind the current keyset cursor.
      updated_at: "2026-07-29T23:59:59Z",
    });

    const registered = registerCreatedSessionWithRoster(base, created);
    const registeredAgain = registerCreatedSessionWithRoster(
      registered,
      created
    );

    expect(registeredAgain.standalone_agent.sessionIds).toEqual([
      "sdeagent-10",
    ]);
    expect(registeredAgain.standalone_agent.localSessionIds).toEqual([
      created.session_id,
    ]);
    expect(registeredAgain.standalone_agent.cursor).toEqual(cursor);
    expect(createSidebarRosterMatcher(registeredAgain)(created)).toBe(true);

    const pinnedGenerationLoaded = {
      ...registeredAgain,
      pinned_native: {
        ...registeredAgain.pinned_native,
        generation: 1,
      },
      standalone_agent: {
        ...registeredAgain.standalone_agent,
        generation: 0,
      },
    };
    expect(
      createSidebarRosterMatcher(pinnedGenerationLoaded)({
        ...created,
        pinned: true,
      })
    ).toBe(true);

    const acknowledged = acknowledgeCreatedSessionsInNativeRoster(
      registeredAgain,
      [created]
    );
    expect(acknowledged.standalone_agent.localSessionIds).toEqual([]);

    const deleted = removeSessionFromRosters(
      registeredAgain,
      created.session_id
    );
    expect(deleted.standalone_agent.localSessionIds).toEqual([]);
  });
});
