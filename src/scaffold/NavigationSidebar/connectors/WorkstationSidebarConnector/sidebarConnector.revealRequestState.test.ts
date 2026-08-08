import { describe, expect, it } from "vitest";

import {
  type Session,
  createSidebarRosterMatcher,
  resetPaginationState,
} from "@src/store/session";

import { buildSidebarOverlaySessionIds } from "./sidebarConnector.revealRequestState";

function makeSession(sessionId: string): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: "2026-07-30T00:00:00Z",
    updated_at: "2026-07-30T00:00:00Z",
  };
}

describe("buildSidebarOverlaySessionIds", () => {
  it("keeps the active session visible without changing the authoritative roster", () => {
    const activeSession = makeSession("sdeagent-active-old");
    const basePagination = resetPaginationState();
    const pagination = {
      ...basePagination,
      standalone_agent: {
        ...basePagination.standalone_agent,
        sessionIds: ["sdeagent-page-1"],
        cursor: {
          updatedAt: "2026-07-30T00:00:00Z",
          sessionId: "sdeagent-page-1",
        },
        phase: "ready" as const,
        generation: 1,
      },
    };

    const rosterMatcher = createSidebarRosterMatcher(pagination);
    const overlayIds = buildSidebarOverlaySessionIds(
      activeSession.session_id,
      null
    );

    expect(rosterMatcher(activeSession)).toBe(false);
    expect(overlayIds.has(activeSession.session_id)).toBe(true);
    expect(pagination.standalone_agent.sessionIds).toEqual(["sdeagent-page-1"]);
    expect(pagination.standalone_agent.cursor).toEqual({
      updatedAt: "2026-07-30T00:00:00Z",
      sessionId: "sdeagent-page-1",
    });
  });

  it("also overlays the parent of an explicitly revealed subagent", () => {
    const overlayIds = buildSidebarOverlaySessionIds("sdeagent-active", {
      requestId: 7,
      issuedAt: 1,
      sessionId: "sdeagent-child",
      parentSessionId: "sdeagent-parent",
    });

    expect([...overlayIds]).toEqual([
      "sdeagent-active",
      "sdeagent-child",
      "sdeagent-parent",
    ]);
  });
});
