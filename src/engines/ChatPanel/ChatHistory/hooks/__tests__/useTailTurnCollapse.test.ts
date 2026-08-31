import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { GroupChatContextValue } from "../../GroupChatView/GroupChatContext";
import {
  TAIL_TURN_STALE_MS,
  findTailTurnId,
  resolveTailTurnAgentWorking,
  resolveTailTurnStaleDelayMs,
} from "../useTailTurnCollapse";

function event(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    id: "event-id",
    sessionId: "session-id",
    source: "assistant",
    args: {},
    result: {},
    ...overrides,
  } as SessionEvent;
}

describe("findTailTurnId", () => {
  it("returns the latest standard user turn and ignores inbox transcript rows", () => {
    const events = [
      event({ id: "user-1", source: "user" }),
      event({ id: "assistant-1" }),
      event({
        id: "inbox-row",
        source: "user",
        args: { agentOrgInboxTranscript: true },
      }),
    ];

    expect(findTailTurnId(events, null)).toBe("user-1");
  });

  it("uses the group-chat coordinator boundary predicate", () => {
    const events = [
      event({ id: "coordinator-turn", source: "user" }),
      event({ id: "member-turn", source: "user" }),
    ];
    const groupChat = {
      enabled: true,
      isCoordinatorTurnHeader: (candidate: SessionEvent) =>
        candidate.id === "coordinator-turn",
    } as GroupChatContextValue;

    expect(findTailTurnId(events, groupChat)).toBe("coordinator-turn");
  });

  it("returns null when no turn boundary exists", () => {
    expect(findTailTurnId([event({ id: "assistant-only" })], null)).toBeNull();
  });
});

describe("resolveTailTurnAgentWorking", () => {
  it.each(["running", "waiting_for_user", "pending", "queued"])(
    "uses the sidebar session status for an active external session (%s)",
    (sessionStatus) => {
      expect(
        resolveTailTurnAgentWorking({
          activeId: "codexapp-session-id",
          isAgentWorking: false,
          sessionStatus,
        })
      ).toBe(true);
    }
  );

  it.each(["completed", "failed", "idle", undefined])(
    "treats an inactive external session as idle (%s)",
    (sessionStatus) => {
      expect(
        resolveTailTurnAgentWorking({
          activeId: "claudecodeapp-session-id",
          isAgentWorking: true,
          sessionStatus,
        })
      ).toBe(false);
    }
  );

  it("keeps the foreground runtime signal authoritative for native sessions", () => {
    expect(
      resolveTailTurnAgentWorking({
        activeId: "sdeagent-session-id",
        isAgentWorking: true,
        sessionStatus: "completed",
      })
    ).toBe(true);
  });
});

describe("resolveTailTurnStaleDelayMs", () => {
  const lastEventMs = 1_000_000;

  it("waits out the remainder of the window for a live session", () => {
    expect(resolveTailTurnStaleDelayMs(lastEventMs, lastEventMs + 60_000)).toBe(
      TAIL_TURN_STALE_MS - 60_000
    );
  });

  it("returns zero for a session reopened after the window closed", () => {
    // A negative remainder would arrive as a synchronous state write from
    // the effect body; clamping routes it through the timer instead.
    expect(
      resolveTailTurnStaleDelayMs(
        lastEventMs,
        lastEventMs + TAIL_TURN_STALE_MS + 60_000
      )
    ).toBe(0);
  });

  it("returns zero exactly on the boundary", () => {
    expect(
      resolveTailTurnStaleDelayMs(lastEventMs, lastEventMs + TAIL_TURN_STALE_MS)
    ).toBe(0);
  });
});
