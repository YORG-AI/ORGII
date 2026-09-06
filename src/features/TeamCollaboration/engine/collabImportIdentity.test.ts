import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { rewriteEventsForImportedSnapshot } from "./collabImportIdentity";

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "source-event",
    chunk_id: "source-chunk",
    sessionId: "source-session",
    createdAt: "2026-08-30T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant_message",
    args: {},
    result: {},
    source: "assistant",
    displayText: "hello",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    ...overrides,
  };
}

describe("rewriteEventsForImportedSnapshot", () => {
  it("namespaces event identity while preserving valid canonical status", () => {
    const [rewritten] = rewriteEventsForImportedSnapshot(
      [event({ activityStatus: "pending" })],
      "local-session"
    );

    expect(rewritten).toMatchObject({
      id: "local-session~source-event",
      chunk_id: "local-session~source-chunk",
      sessionId: "local-session",
      activityStatus: "pending",
    });
  });

  it("normalizes legacy missing renderer fields before durable import", () => {
    const legacyUser = event({
      source: "user",
      chunk_id: undefined,
      activityStatus: undefined,
    } as Partial<SessionEvent>);
    const legacyAssistant = event({
      chunk_id: undefined,
      activityStatus: "unknown",
    } as unknown as Partial<SessionEvent>);

    const rewritten = rewriteEventsForImportedSnapshot(
      [legacyUser, legacyAssistant],
      "local-session"
    );

    expect(
      rewritten.map(({ chunk_id, activityStatus }) => ({
        chunk_id,
        activityStatus,
      }))
    ).toEqual([
      { chunk_id: null, activityStatus: "processed" },
      { chunk_id: null, activityStatus: "agent" },
    ]);
  });
});
