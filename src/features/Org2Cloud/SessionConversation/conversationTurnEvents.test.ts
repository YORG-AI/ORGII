import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { sliceAppendedTurnTail } from "./conversationTurnEvents";

function event(
  id: string,
  source: "user" | "assistant" | "system"
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "cliagent-session",
    source,
  } as SessionEvent;
}

describe("sliceAppendedTurnTail", () => {
  it("uses a stable native-transcript prefix as the turn boundary", () => {
    const before = [event("user-old", "user"), event("reply-old", "assistant")];
    const after = [
      ...before,
      event("user-new", "user"),
      event("tool-new", "system"),
      event("reply-new", "assistant"),
    ];

    expect(
      sliceAppendedTurnTail(before, after)?.map((item) => item.id)
    ).toEqual(["tool-new", "reply-new"]);
  });

  it("fails closed when the provider rewrites the previous prefix", () => {
    const before = [event("user-old", "user"), event("reply-old", "assistant")];
    const after = [
      event("user-old", "user"),
      event("reply-rewritten", "assistant"),
      event("user-new", "user"),
      event("reply-new", "assistant"),
    ];

    expect(sliceAppendedTurnTail(before, after)).toBeNull();
  });

  it("requires an appended user boundary", () => {
    expect(
      sliceAppendedTurnTail([], [event("assistant-only", "assistant")])
    ).toBeNull();
  });
});
