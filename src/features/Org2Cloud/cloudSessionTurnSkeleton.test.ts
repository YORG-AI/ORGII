import { describe, expect, it, vi } from "vitest";

import { buildCloudTurnSkeletonEvents } from "./cloudSessionTurnSkeleton";
import type { CloudSessionTurnSummary } from "./org2CloudSyncClient";

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { set: vi.fn() },
}));

const LOCAL_SESSION_ID = "imported-session-abc123";

function turn(
  overrides: Partial<CloudSessionTurnSummary> = {}
): CloudSessionTurnSummary {
  return {
    turnId: "evt-user-1",
    prompt: "please fix the login bug",
    eventCount: 6,
    bodyEventCount: 5,
    startedAt: "2026-07-30T01:00:00.000Z",
    endedAt: "2026-07-30T01:02:00.000Z",
    durationMs: 120_000,
    nextTurnId: "evt-user-2",
    ...overrides,
  };
}

describe("buildCloudTurnSkeletonEvents", () => {
  it("builds a namespaced user header + placeholder pair per round", () => {
    const events = buildCloudTurnSkeletonEvents(LOCAL_SESSION_ID, [turn()]);
    expect(events).toHaveLength(2);

    const header = events[0];
    // Ids are namespaced into the local copy's id space so the
    // post-download hydration replaces the skeleton in place.
    expect(header.id).toBe(`${LOCAL_SESSION_ID}~evt-user-1`);
    expect(header.functionName).toBe("user_message");
    expect(header.source).toBe("user");
    expect(header.displayText).toBe("please fix the login bug");
    expect(header.result).toMatchObject({
      syntheticTurnHeader: true,
      message: { content: "please fix the login bug", role: "user" },
    });

    const placeholder = events[1];
    expect(placeholder.id).toBe(
      `turn-placeholder-${LOCAL_SESSION_ID}~evt-user-1`
    );
    expect(placeholder.functionName).toBe("turn_placeholder");
    expect(placeholder.result).toMatchObject({
      unloadedTurn: {
        turnId: `${LOCAL_SESSION_ID}~evt-user-1`,
        eventCount: 5,
        bodyEventCount: 5,
        durationMs: 120_000,
        startedAt: "2026-07-30T01:00:00.000Z",
        endedAt: "2026-07-30T01:02:00.000Z",
        nextTurnId: `${LOCAL_SESSION_ID}~evt-user-2`,
      },
    });
  });

  it("skips the placeholder for zero-body rounds (no dead expand bar)", () => {
    const events = buildCloudTurnSkeletonEvents(LOCAL_SESSION_ID, [
      turn({ bodyEventCount: 0 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].functionName).toBe("user_message");
  });

  it("orders rounds chronologically with the header before its placeholder", () => {
    const events = buildCloudTurnSkeletonEvents(LOCAL_SESSION_ID, [
      turn({
        turnId: "evt-late",
        startedAt: "2026-07-30T02:00:00.000Z",
        endedAt: "2026-07-30T02:01:00.000Z",
        nextTurnId: undefined,
      }),
      turn(),
    ]);
    expect(events.map((event) => event.id)).toEqual([
      `${LOCAL_SESSION_ID}~evt-user-1`,
      `turn-placeholder-${LOCAL_SESSION_ID}~evt-user-1`,
      `${LOCAL_SESSION_ID}~evt-late`,
      `turn-placeholder-${LOCAL_SESSION_ID}~evt-late`,
    ]);
  });
});
