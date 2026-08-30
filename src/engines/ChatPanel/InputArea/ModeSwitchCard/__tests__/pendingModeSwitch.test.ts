import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  extractPendingModeSwitch,
  pendingModeSwitchEqual,
} from "../pendingModeSwitch";

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "ms-1",
    chunk_id: "ms-1",
    sessionId: "session-1",
    createdAt: "2026-06-18T00:00:00.000Z",
    functionName: "suggest_mode_switch",
    uiCanonical: "suggest_mode_switch",
    actionType: "tool_call",
    args: { target_mode: "plan", reason: "Need a plan" },
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "awaiting_user",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  } as SessionEvent;
}

describe("extractPendingModeSwitch", () => {
  it("returns null when there is no mode-switch event", () => {
    expect(
      extractPendingModeSwitch([
        event({ functionName: "agent_message", id: "msg-1" }),
      ])
    ).toBeNull();
  });

  it("returns the latest unprocessed mode-switch payload", () => {
    expect(
      extractPendingModeSwitch([
        event({ id: "old", args: { target_mode: "code", reason: "old" } }),
        event({
          id: "new",
          args: { targetModeId: "plan", explanation: "Need a plan" },
        }),
      ])
    ).toEqual({
      eventId: "new",
      targetMode: "plan",
      reason: "Need a plan",
      createdAt: "2026-06-18T00:00:00.000Z",
    });
  });

  it("skips processed events", () => {
    expect(
      extractPendingModeSwitch([event({ activityStatus: "processed" })])
    ).toBeNull();
  });
});

describe("pendingModeSwitchEqual", () => {
  it("treats identical payloads as equal", () => {
    const pending = extractPendingModeSwitch([event()]);
    expect(pendingModeSwitchEqual(pending, { ...pending! })).toBe(true);
  });
});
