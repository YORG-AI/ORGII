import type { SessionEvent } from "@src/engines/SessionCore";

import {
  EVENT_TYPE_COLORS,
  calculateEventSegments,
  getEventTypeForColor,
} from "../eventSegments";

function makeSessionEvent(
  overrides: Partial<SessionEvent> & Pick<SessionEvent, "functionName">
): SessionEvent {
  return {
    chunk_id: null,
    id: "event-id",
    sessionId: "session-id",
    createdAt: "2025-01-01T00:00:00Z",
    actionType: "tool_call",
    uiCanonical: "",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

describe("getEventTypeForColor", () => {
  it("returns edit when diffString is present on result", () => {
    const event = makeSessionEvent({
      functionName: "anything",
      result: { diffString: "--- a\n+++ b" },
    });
    expect(getEventTypeForColor(event)).toBe("edit");
  });

  it("returns edit when diffString is nested under output.success", () => {
    const event = makeSessionEvent({
      functionName: "noop",
      result: {
        output: { success: { diffString: "diff" } },
      },
    });
    expect(getEventTypeForColor(event)).toBe("edit");
  });

  it("classifies file-like function names", () => {
    expect(
      getEventTypeForColor(makeSessionEvent({ functionName: "read_file" }))
    ).toBe("file");
    expect(
      getEventTypeForColor(makeSessionEvent({ functionName: "READ" }))
    ).toBe("file");
  });

  it("classifies shell-like function names", () => {
    expect(
      getEventTypeForColor(makeSessionEvent({ functionName: "run_shell" }))
    ).toBe("shell");
    expect(
      getEventTypeForColor(makeSessionEvent({ functionName: "bash_tool" }))
    ).toBe("shell");
  });

  it("classifies assistant-like function names", () => {
    expect(
      getEventTypeForColor(makeSessionEvent({ functionName: "assistant" }))
    ).toBe("assistant");
    expect(
      getEventTypeForColor(makeSessionEvent({ functionName: "send_message" }))
    ).toBe("assistant");
  });

  it("returns unknown when no rule matches", () => {
    expect(
      getEventTypeForColor(
        makeSessionEvent({ functionName: "custom_tool_xyz" })
      )
    ).toBe("unknown");
  });
});

describe("calculateEventSegments", () => {
  it("returns empty array for no events", () => {
    expect(calculateEventSegments([])).toEqual([]);
  });

  it("builds a single full-width segment for one event", () => {
    const events = [makeSessionEvent({ functionName: "read_file" })];
    const segments = calculateEventSegments(events);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startPercent: 0,
      endPercent: 100,
      type: "file",
      color: EVENT_TYPE_COLORS.file,
    });
  });

  it("merges consecutive events of the same type into one segment", () => {
    const events = [
      makeSessionEvent({ functionName: "read_file" }),
      makeSessionEvent({ functionName: "read_file" }),
    ];
    const segments = calculateEventSegments(events);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startPercent).toBe(0);
    expect(segments[0]?.endPercent).toBe(100);
  });

  it("splits segments when event types change", () => {
    const events = [
      makeSessionEvent({ functionName: "read_file" }),
      makeSessionEvent({ functionName: "run_shell" }),
    ];
    const segments = calculateEventSegments(events);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.type).toBe("file");
    expect(segments[0]?.endPercent).toBe(50);
    expect(segments[1]?.type).toBe("shell");
    expect(segments[1]?.startPercent).toBe(50);
    expect(segments[1]?.endPercent).toBe(100);
  });
});
