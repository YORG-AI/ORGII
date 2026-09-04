import { describe, expect, it } from "vitest";

import {
  MAX_MOBILE_TRANSCRIPT_ITEMS,
  createInitialTranscriptState,
  demoTranscriptItems,
  reduceTranscriptFromUpserts,
} from "./transcriptReducer";

describe("transcriptReducer", () => {
  it("projects user and agent upserts", () => {
    const next = reduceTranscriptFromUpserts(createInitialTranscriptState(), [
      {
        id: "u1",
        uiCanonical: "user",
        args: { content: "hello" },
      },
      {
        id: "a1",
        uiCanonical: "agent",
        displayText: "working",
      },
    ]);
    expect(next.items).toHaveLength(2);
    expect(next.items[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(next.items[1]).toMatchObject({ kind: "agent", text: "working" });
  });

  it("projects the normalized desktop wire contract", () => {
    const next = reduceTranscriptFromUpserts(createInitialTranscriptState(), [
      {
        id: "u-wire",
        turnIntentId: "intent-wire",
        uiCanonical: "user_message",
        source: "user",
        displayVariant: "message",
        result: { message: { content: "from desktop" } },
        createdAt: "2026-08-29T10:00:00Z",
      },
      {
        id: "a-wire",
        uiCanonical: "agent_message",
        source: "assistant",
        displayVariant: "message",
        displayStatus: "completed",
        displayText: "history reply",
        createdAt: "2026-08-29T10:00:01Z",
      },
      {
        id: "tool-wire",
        uiCanonical: "run_shell",
        functionName: "run_shell",
        actionType: "tool_call",
        displayVariant: "tool_call",
        displayStatus: "completed",
        displayText: "pnpm test",
        toolSummary: "pnpm test",
        toolData: {
          kind: "shell",
          command: "pnpm test",
          output: "19 tests passed",
          isFailure: false,
        },
        toolDataTruncated: true,
        callId: "call-shell",
        createdAt: "2026-08-29T10:00:02Z",
      },
    ]);

    expect(next.items).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "from desktop",
        turnIntentId: "intent-wire",
      }),
      expect.objectContaining({ kind: "agent", text: "history reply" }),
      expect.objectContaining({
        kind: "tool",
        toolName: "run_shell",
        toolStatus: "completed",
        toolSummary: "pnpm test",
        toolData: expect.objectContaining({
          kind: "shell",
          command: "pnpm test",
        }),
        toolDataTruncated: true,
        toolCallId: "call-shell",
      }),
    ]);
  });

  it("merges a live tool lifecycle update in place without losing its structured target", () => {
    const running = reduceTranscriptFromUpserts(
      createInitialTranscriptState(),
      [
        {
          id: "tool-live",
          uiCanonical: "read_file",
          functionName: "read_file",
          actionType: "tool_call",
          displayStatus: "running",
          toolSummary: "src/App.tsx",
          toolData: {
            kind: "file",
            filePath: "src/App.tsx",
            fileName: "App.tsx",
            language: "typescript",
          },
        },
      ]
    );
    const completed = reduceTranscriptFromUpserts(running, [
      {
        id: "tool-live",
        uiCanonical: "read_file",
        functionName: "read_file",
        actionType: "tool_call",
        displayStatus: "completed",
        toolSummary: "src/App.tsx",
        toolData: {
          kind: "file",
          filePath: "src/App.tsx",
          fileName: "App.tsx",
          language: "typescript",
          lineCount: 42,
        },
      },
    ]);

    expect(completed.items).toHaveLength(1);
    expect(completed.items[0]).toMatchObject({
      toolStatus: "completed",
      toolSummary: "src/App.tsx",
      toolData: expect.objectContaining({ lineCount: 42 }),
    });
  });

  it("provides stable demo items", () => {
    expect(demoTranscriptItems()).toHaveLength(2);
  });

  it("merges streaming updates by event id and removes deleted events", () => {
    const initial = reduceTranscriptFromUpserts(
      createInitialTranscriptState(),
      [
        { id: "a1", uiCanonical: "agent", displayText: "working" },
        { id: "u1", uiCanonical: "user", args: { content: "hello" } },
      ]
    );
    const next = reduceTranscriptFromUpserts(
      initial,
      [{ id: "a1", uiCanonical: "agent", displayText: "done" }],
      { removedIds: ["u1"] }
    );

    expect(next.items).toEqual([
      expect.objectContaining({ id: "a1", text: "done" }),
    ]);
  });

  it("replaces a full snapshot and caps retained transcript items", () => {
    const stale = reduceTranscriptFromUpserts(createInitialTranscriptState(), [
      { id: "stale", uiCanonical: "user", args: { content: "old" } },
    ]);
    const fullSnapshot = Array.from(
      { length: MAX_MOBILE_TRANSCRIPT_ITEMS + 5 },
      (_, index) => ({
        id: `event-${index}`,
        uiCanonical: "agent",
        displayText: `message-${index}`,
      })
    );
    const next = reduceTranscriptFromUpserts(stale, fullSnapshot, {
      replace: true,
    });

    expect(next.items).toHaveLength(MAX_MOBILE_TRANSCRIPT_ITEMS);
    expect(next.items[0].id).toBe("event-5");
    expect(next.items.at(-1)?.id).toBe(
      `event-${MAX_MOBILE_TRANSCRIPT_ITEMS + 4}`
    );
    expect(next.items.some((item) => item.id === "stale")).toBe(false);
  });
});
