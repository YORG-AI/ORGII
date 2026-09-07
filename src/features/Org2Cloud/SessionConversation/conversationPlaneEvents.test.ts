import { describe, expect, it } from "vitest";

import {
  NATIVE_SOURCE_EVENT_ID_ARG,
  projectNativeConversationItems,
} from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import { buildConversationPlaneStreamEvents } from "./conversationPlaneEvents";

function assistant(
  sessionId: string,
  text: string,
  rowId: string
): CloudConversationEvent {
  const event = {
    id: `${sessionId}-event`,
    chunk_id: `${sessionId}-event`,
    sessionId,
    createdAt: "2026-09-05T10:00:00.000Z",
    functionName: "assistant",
    uiCanonical: "assistant",
    actionType: "assistant",
    args: { [NATIVE_SOURCE_EVENT_ID_ARG]: "codex-asst-97" },
    result: { content: text },
    source: "assistant",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
  return {
    id: rowId,
    rootSessionId: "root",
    authorUserId: "user",
    turnId: `turn-${rowId}`,
    seq: Number(rowId.replace(/\D/g, "")),
    event,
    createdAt: event.createdAt,
  };
}

describe("buildConversationPlaneStreamEvents", () => {
  it("scopes reused legacy provider ids before replacing the native session id", () => {
    const streamed = buildConversationPlaneStreamEvents(
      [
        assistant("codex-episode-a", "first", "row-1"),
        assistant("codex-episode-b", "second", "row-2"),
      ],
      "shared-root"
    );
    const items = projectNativeConversationItems(streamed);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual([
      expect.stringMatching(/^orgii_evt_[a-f0-9]{32}$/),
      expect.stringMatching(/^orgii_evt_[a-f0-9]{32}$/),
    ]);
    expect(new Set(items.map((item) => item.id))).toHaveProperty("size", 2);
    expect(items.map((item) => item.id)).not.toContain("codex-asst-97");
  });
});
