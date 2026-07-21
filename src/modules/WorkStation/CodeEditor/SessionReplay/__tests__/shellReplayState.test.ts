import { describe, expect, it } from "vitest";

import type {
  SessionEvent,
  ShellReplayState,
} from "@src/engines/SessionCore/core/types";

import {
  bindShellOperationToCursor,
  resolveShellReplayStateForCursor,
} from "../shellReplayState";
import type { ShellOperationEntry } from "../types";

function replayState(
  visibleBytes: number,
  overrides: Partial<ShellReplayState> = {}
): ShellReplayState {
  return {
    ref: { sessionId: "session-1", callId: "call-1", formatVersion: 1 },
    bookmark: {
      visibleThroughSequence: visibleBytes,
      visibleBytes,
    },
    terminalPreview: `preview-${visibleBytes}`,
    status: "running",
    ...overrides,
  };
}

function event(
  id: string,
  createdAt: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id,
    sessionId: "session-1",
    createdAt,
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: { command: "printf test" },
    result: {},
    source: "assistant",
    displayText: "printf test",
    displayStatus: "running",
    displayVariant: "tool_call",
    activityStatus: "agent",
    callId: "call-1",
    ...overrides,
  };
}

function operation(latest: ShellReplayState): ShellOperationEntry {
  const shellEvent = event("tool-call-1", "2026-07-19T10:00:00.000Z", {
    shellReplay: latest,
  });
  return {
    command: "printf test",
    shortCommand: "printf",
    commandKeywords: "printf",
    output: "mutable final output",
    event: shellEvent,
    eventId: shellEvent.id,
    isCurrent: false,
    replayRef: latest.ref,
  };
}

describe("resolveShellReplayStateForCursor", () => {
  it("uses the immutable current cursor bookmark during historical replay", () => {
    const latest = replayState(1_000);
    const checkpoint = replayState(200);
    const cursor = event("cursor-early", "2026-07-19T10:00:01.000Z", {
      shellReplayBookmarks: { "call-1": checkpoint },
    });

    expect(
      resolveShellReplayStateForCursor(operation(latest), cursor, false)
    ).toBe(checkpoint);
  });

  it("lets the mutable latest state win at the live edge", () => {
    const latest = replayState(1_000);
    const cursor = event("cursor-tail", "2026-07-19T10:00:01.000Z", {
      shellReplayBookmarks: { "call-1": replayState(0) },
    });

    expect(
      resolveShellReplayStateForCursor(operation(latest), cursor, true)
    ).toBe(latest);
  });

  it("does not expose a final mutable state before its completion time", () => {
    const latest = replayState(1_000, {
      status: "complete",
      completedAt: "2026-07-19T10:00:05.000Z",
    });
    const earlyCursor = event("cursor-early", "2026-07-19T10:00:02.000Z");

    expect(
      resolveShellReplayStateForCursor(operation(latest), earlyCursor, false)
    ).toBeUndefined();
    const bound = bindShellOperationToCursor(
      operation(latest),
      earlyCursor,
      false
    );
    expect(bound?.replayRef?.callId).toBe("call-1");
    expect(bound?.replayState).toBeUndefined();
    expect(bound?.output).toBeUndefined();
  });

  it("keeps only a separate early cursor's bounded legacy stream preview", () => {
    const latest = replayState(1_000, {
      status: "complete",
      completedAt: "2026-07-19T10:00:05.000Z",
      terminalPreview: "FINAL OUTPUT MUST NOT LEAK",
    });
    const earlyCursor = event(
      "cursor-stream-checkpoint",
      "2026-07-19T10:00:02.000Z",
      {
        args: {
          callId: "call-1",
          streamOutput: "safe output captured at this cursor",
        },
      }
    );

    const bound = bindShellOperationToCursor(
      operation(latest),
      earlyCursor,
      false
    );

    expect(bound?.replayState).toBeUndefined();
    expect(bound?.output).toBe("safe output captured at this cursor");
    expect(bound?.output).not.toContain("FINAL OUTPUT");
  });

  it.each([
    ["same event", { id: "tool-call-1" }],
    ["wrong Session", { sessionId: "session-2" }],
    ["wrong call", { callId: "call-2" }],
  ])("does not use a %s legacy stream preview", (_label, cursorOverrides) => {
    const latest = replayState(1_000, {
      status: "complete",
      completedAt: "2026-07-19T10:00:05.000Z",
    });
    const cursor = event("cursor-preview", "2026-07-19T10:00:02.000Z", {
      args: { streamOutput: "unsafe cursor preview" },
      ...cursorOverrides,
    });

    const bound = bindShellOperationToCursor(operation(latest), cursor, false);

    expect(bound?.replayState).toBeUndefined();
    expect(bound?.output).toBeUndefined();
  });

  it("uses a final state for a later cursor after durable completion", () => {
    const latest = replayState(1_000, {
      status: "complete",
      completedAt: "2026-07-19T10:00:05.000Z",
    });
    const laterCursor = event("cursor-later", "2026-07-19T10:00:06.000Z");

    expect(
      resolveShellReplayStateForCursor(operation(latest), laterCursor, false)
    ).toBe(latest);
  });

  it("keeps a legacy shell output when the cursor bookmarks only another call", () => {
    const legacyEvent = event("legacy-call", "2026-07-19T10:00:00.000Z", {
      callId: "legacy-call-id",
      shellReplay: undefined,
    });
    const legacyOperation: ShellOperationEntry = {
      command: "printf legacy",
      shortCommand: "printf",
      commandKeywords: "printf",
      output: "legacy preview must remain visible",
      event: legacyEvent,
      eventId: legacyEvent.id,
      isCurrent: false,
    };
    const otherCall = replayState(200);
    const cursor = event("cursor-with-other-call", "2026-07-19T10:00:01.000Z", {
      shellReplayBookmarks: { "call-1": otherCall },
    });

    const bound = bindShellOperationToCursor(legacyOperation, cursor, false);

    expect(bound?.replayRef).toBeUndefined();
    expect(bound?.replayState).toBeUndefined();
    expect(bound?.output).toBe("legacy preview must remain visible");
  });

  it("rejects a same-call bookmark from another Session", () => {
    const latest = replayState(1_000);
    const wrongSession = replayState(200, {
      ref: {
        sessionId: "session-2",
        callId: "call-1",
        formatVersion: 1,
      },
    });
    const cursor = event("cursor-cross-session", "2026-07-19T10:00:01.000Z", {
      shellReplayBookmarks: { "call-1": wrongSession },
    });

    expect(
      resolveShellReplayStateForCursor(operation(latest), cursor, false)
    ).toBeUndefined();
  });
});
