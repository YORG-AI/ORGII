import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  TERMINAL_READ_ONLY_MAX_PREVIEW_BYTES,
  appendBoundedTerminalTail,
  execOutputKey,
  historyPreviewFromEvent,
} from "./outputBuffer";

const encoder = new TextEncoder();

function shellEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "event-1",
    chunk_id: "event-1",
    sessionId: "session-1",
    createdAt: "2026-07-19T00:00:00.000Z",
    functionName: "shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    callId: "call-1",
    shellReplay: {
      ref: { sessionId: "session-1", callId: "call-1", formatVersion: 1 },
      bookmark: { visibleThroughSequence: 4, visibleBytes: 10 },
      terminalPreview: "bounded preview",
      status: "complete",
    },
    ...overrides,
  };
}

describe("TerminalReadOnly bounded output", () => {
  it("keeps at most a 32KiB valid UTF-8 tail", () => {
    const output = appendBoundedTerminalTail(
      "prefix",
      `discard-${"x".repeat(TERMINAL_READ_ONLY_MAX_PREVIEW_BYTES)}中文🙂tail`
    );

    expect(encoder.encode(output).length).toBeLessThanOrEqual(
      TERMINAL_READ_ONLY_MAX_PREVIEW_BYTES
    );
    expect(output).toContain("中文🙂tail");
    expect(output).not.toContain("�");
    expect(output).not.toContain("prefix");
  });

  it("requires an exact session and non-empty call identity", () => {
    const detail = {
      sessionId: "session-1",
      callId: "call-1",
      chunk: "hello",
      stream: "stdout" as const,
    };

    expect(execOutputKey(detail, "session-1")).toBe("9:session-1call-1");
    expect(execOutputKey(detail, "session-2")).toBeNull();
    expect(execOutputKey({ ...detail, callId: "" }, "session-1")).toBeNull();
  });

  it("uses only the replay preview and never the legacy full result output", () => {
    const event = shellEvent({
      command: "printf test",
      shellExitCode: 7,
      result: { output: "future/full result must not render" },
    });

    expect(historyPreviewFromEvent(event)).toEqual({
      key: "9:session-1call-1",
      command: "printf test",
      output: "bounded preview",
      exitCode: 7,
    });
  });

  it("rejects replay metadata that does not belong to the event session/call", () => {
    const wrongSession = shellEvent({
      shellReplay: {
        ...shellEvent().shellReplay!,
        ref: {
          sessionId: "session-2",
          callId: "call-1",
          formatVersion: 1,
        },
      },
    });
    const wrongCall = shellEvent({
      callId: "call-2",
    });

    expect(historyPreviewFromEvent(wrongSession)).toBeNull();
    expect(historyPreviewFromEvent(wrongCall)).toBeNull();
  });
});
