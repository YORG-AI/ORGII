import { describe, expect, it } from "vitest";

import {
  SessionEventArraySchema,
  ShellReplayBookmarkSchema,
  ShellReplayFrameSchema,
  ShellReplayRangeInput,
  ShellReplayRangeSchema,
  TurnMetadataIndexInput,
} from "../schemas/sessionCore";

describe("sessionCore RPC schemas", () => {
  it("normalizes legacy string result values instead of rejecting history loads", () => {
    const parsed = SessionEventArraySchema.parse([
      makeEvent("event-1", "first message", "2026-05-16T00:00:00.000Z"),
      makeEvent(
        "event-2",
        { content: "second message" },
        "2026-05-16T00:00:01.000Z"
      ),
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].result).toEqual({
      content: "first message",
      observation: "first message",
    });
    expect(parsed[1].result).toEqual({ content: "second message" });
  });

  it("bounds visible-round metadata reads", () => {
    expect(
      TurnMetadataIndexInput.parse({
        sessionId: "session-1",
        turnIds: ["turn-2", "turn-3"],
      }).turnIds
    ).toEqual(["turn-2", "turn-3"]);
    expect(() =>
      TurnMetadataIndexInput.parse({
        sessionId: "session-1",
        turnIds: Array.from({ length: 501 }, (_, index) => `turn-${index}`),
      })
    ).toThrow();
  });

  it("keeps shell replay checkpoints on the immutable cursor event", () => {
    const raw = makeEvent(
      "cursor-1",
      { content: "cursor" },
      "2026-07-19T00:00:01.000Z"
    );
    raw.shellReplayBookmarks = {
      "call-1": {
        ref: {
          sessionId: "session-history-regression",
          callId: "call-1",
          formatVersion: 1,
        },
        bookmark: { visibleThroughSequence: 4, visibleBytes: 128 },
        terminalPreview: "bounded tail",
        status: "running",
      },
    };

    const parsed = SessionEventArraySchema.parse([raw]);
    expect(
      parsed[0].shellReplayBookmarks?.["call-1"].bookmark.visibleBytes
    ).toBe(128);
  });

  it("preserves explicit external replay payload encoding and accepts legacy refs", () => {
    const explicit = makeEvent(
      "event-explicit",
      { output: "preview" },
      "2026-07-23T00:00:00.000Z"
    );
    explicit.payloadRefs = [
      {
        eventId: "event-explicit",
        fieldPath: "args",
        preview: "preview",
        fullSizeBytes: 1024,
        truncated: true,
        replayEncoding: "json_value",
      },
    ];
    const legacy = makeEvent(
      "event-legacy",
      { output: "preview" },
      "2026-07-23T00:00:01.000Z"
    );
    legacy.payloadRefs = [
      {
        eventId: "event-legacy",
        fieldPath: "result.output",
        preview: "preview",
        fullSizeBytes: 1024,
        truncated: true,
      },
    ];

    const parsed = SessionEventArraySchema.parse([explicit, legacy]);
    expect(parsed[0].payloadRefs?.[0].replayEncoding).toBe("json_value");
    expect(parsed[1].payloadRefs?.[0].replayEncoding).toBeUndefined();
  });

  it("caps shell replay range reads at 256 KiB", () => {
    expect(() =>
      ShellReplayRangeInput.parse({
        sessionId: "session-1",
        callId: "call-1",
        visibleThroughSequence: 10,
        visibleBytes: 1024 * 1024,
        offsetBytes: 0,
        limitBytes: 256 * 1024 + 1,
      })
    ).toThrow();
  });

  it("rejects replay u64 values that JavaScript cannot represent exactly", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    expect(() =>
      ShellReplayBookmarkSchema.parse({
        visibleThroughSequence: unsafeInteger,
        visibleBytes: 0,
      })
    ).toThrow();
    expect(() =>
      ShellReplayRangeInput.parse({
        sessionId: "session-1",
        callId: "call-1",
        visibleThroughSequence: 1,
        visibleBytes: unsafeInteger,
        offsetBytes: 0,
        limitBytes: 1,
      })
    ).toThrow();
    expect(() =>
      ShellReplayFrameSchema.parse({
        sequence: 1,
        stream: "stdout",
        byteStart: 0,
        byteEnd: unsafeInteger,
        text: "",
      })
    ).toThrow();
    expect(() =>
      ShellReplayRangeSchema.parse({
        frames: [],
        nextOffsetBytes: unsafeInteger,
        eof: true,
      })
    ).toThrow();
  });
});

function makeEvent(
  id: string,
  result: unknown,
  createdAt: string
): Record<string, unknown> {
  return {
    chunk_id: null,
    id,
    sessionId: "session-history-regression",
    createdAt,
    functionName: "message",
    uiCanonical: "message",
    actionType: "message",
    args: {},
    result,
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}
