import { describe, expect, it } from "vitest";

import { buildCloudCommentSourceEventIdMap } from "./SessionCommentsContext";

const LIVE_MESSAGE_ID = "70c0418c-eb0c-4a84-8a52-1bca10e605b7";

describe("buildCloudCommentSourceEventIdMap", () => {
  it("normalizes a transient Rust-native user UUID to its durable event id", () => {
    const mapping = buildCloudCommentSourceEventIdMap(
      { session_id: "s-1", category: "rust_agent" },
      [{ id: LIVE_MESSAGE_ID, source: "user" }]
    );

    expect(mapping.get(LIVE_MESSAGE_ID)).toBe(
      `user-message-${LIVE_MESSAGE_ID}`
    );
  });

  it("keeps persisted, seeded, non-user, and external-history ids unchanged", () => {
    const nativeMapping = buildCloudCommentSourceEventIdMap(
      { session_id: "s-1", category: "rust_agent" },
      [
        { id: `user-message-${LIVE_MESSAGE_ID}`, source: "user" },
        { id: "user-2-s-1", source: "user" },
        { id: LIVE_MESSAGE_ID, source: "assistant" },
      ]
    );
    const externalMapping = buildCloudCommentSourceEventIdMap(
      { session_id: "external-1", category: "external_history" },
      [{ id: LIVE_MESSAGE_ID, source: "user" }]
    );

    expect(nativeMapping.get(`user-message-${LIVE_MESSAGE_ID}`)).toBe(
      `user-message-${LIVE_MESSAGE_ID}`
    );
    expect(nativeMapping.get("user-2-s-1")).toBe("user-2-s-1");
    expect(nativeMapping.get(LIVE_MESSAGE_ID)).toBe(LIVE_MESSAGE_ID);
    expect(externalMapping.get(LIVE_MESSAGE_ID)).toBe(LIVE_MESSAGE_ID);
  });

  it("strips import and fork namespaces before matching cloud comments", () => {
    const importedSessionId = "imported-session-1";
    const importedEventId = `${importedSessionId}~user-message-${LIVE_MESSAGE_ID}`;
    const mapping = buildCloudCommentSourceEventIdMap(
      { session_id: importedSessionId, category: "external_history" },
      [{ id: importedEventId, source: "user" }]
    );

    expect(mapping.get(importedEventId)).toBe(
      `user-message-${LIVE_MESSAGE_ID}`
    );
  });
});
