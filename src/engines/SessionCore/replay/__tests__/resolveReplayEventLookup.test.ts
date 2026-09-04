import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  resolveReplayEventIndex,
  resolveReplayEventLookup,
} from "../resolveReplayEventLookup";

function event(
  id: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "session-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    functionName: "read_file",
    uiCanonical: "read_file",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    ...overrides,
  } as SessionEvent;
}

describe("resolveReplayEventLookup", () => {
  it("resolves by canonical event id", () => {
    const events = [event("read-a"), event("read-b")];
    expect(resolveReplayEventLookup(events, "read-b")?.id).toBe("read-b");
  });

  it("resolves chunk_id aliases", () => {
    const events = [
      event("event-id", { chunk_id: "legacy-chunk-id" }),
      event("other"),
    ];
    expect(resolveReplayEventLookup(events, "legacy-chunk-id")?.id).toBe(
      "event-id"
    );
  });

  it("returns null when the id is unknown", () => {
    expect(resolveReplayEventLookup([event("read-a")], "missing")).toBeNull();
  });
});

describe("resolveReplayEventIndex", () => {
  it("returns the index of the resolved event", () => {
    const events = [event("a"), event("b"), event("c")];
    expect(resolveReplayEventIndex(events, "b")).toBe(1);
  });

  it("returns -1 when lookup fails", () => {
    expect(resolveReplayEventIndex([event("a")], "missing")).toBe(-1);
  });
});
