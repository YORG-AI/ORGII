import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { buildRemoteReplaySnapshot } from "./remoteReplaySnapshot";

function event(
  id: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "remote-session",
    createdAt: "2026-08-19T00:00:00.000Z",
    functionName: "message",
    uiCanonical: "message",
    actionType: "message",
    args: {},
    result: {},
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    ...overrides,
  } as SessionEvent;
}

describe("buildRemoteReplaySnapshot", () => {
  it("projects cloud events into the desktop replay snapshot contract", () => {
    const later = event("later", {
      createdAt: "2026-08-19T00:00:02.000Z",
    });
    const earlier = event("earlier", {
      createdAt: "2026-08-19T00:00:01.000Z",
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
    });

    const snapshot = buildRemoteReplaySnapshot([later, earlier], {
      version: 7,
    });

    expect(snapshot.version).toBe(7);
    expect(snapshot.events).toEqual([later, earlier]);
    expect(snapshot.eventIndex).toEqual({ later: 0, earlier: 1 });
    expect(snapshot.sortedSimulatorEventIds).toEqual(["earlier", "later"]);
    expect(snapshot.eventPreviewById?.earlier.functionName).toBe("read_file");
  });

  it("does not expose delta and tool-result rows as workstation frames", () => {
    const delta = event("delta", { isDelta: true });
    const result = event("result", {
      actionType: "tool_result",
      displayVariant: "tool_call",
    });

    const snapshot = buildRemoteReplaySnapshot([delta, result], {
      version: 8,
    });

    expect(snapshot.sortedSimulatorEvents).toEqual([]);
    expect(snapshot.sortedSimulatorEventIds).toEqual([]);
  });

  it("projects only the replay prefix when endIndex is provided", () => {
    const first = event("first", { isDelta: true });
    const second = event("second", {
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
    });
    const third = event("third");

    const snapshot = buildRemoteReplaySnapshot([first, second, third], {
      endIndex: 1,
      version: 9,
    });

    expect(snapshot.events).toEqual([first, second]);
    expect(snapshot.sortedSimulatorEventIds).toEqual(["second"]);
    expect(snapshot.version).toBe(9);
  });
});
