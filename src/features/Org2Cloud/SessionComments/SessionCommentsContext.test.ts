import { describe, expect, it, vi } from "vitest";

import { Org2CloudCommentError } from "../org2CloudCommentsClient";
import { SessionCommentDeliveryError } from "../org2CloudSessionCommentsAtom";
import {
  addCommentWithSessionAdmissionRecovery,
  buildCloudCommentSourceEventIdMap,
} from "./SessionCommentsContext";

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

describe("addCommentWithSessionAdmissionRecovery", () => {
  it("repairs an owner admission race and retries the same Team Chat comment once", async () => {
    const comment = { id: "comment-1" } as never;
    const add = vi
      .fn<() => Promise<typeof comment>>()
      .mockRejectedValueOnce(
        new Org2CloudCommentError("ORG2_SESSION_NOT_FOUND", 404)
      )
      .mockResolvedValueOnce(comment);
    const repair = vi.fn(async () => undefined);

    await expect(
      addCommentWithSessionAdmissionRecovery(add, repair)
    ).resolves.toBe(comment);
    expect(repair).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("retries the retained optimistic row instead of inserting a duplicate", async () => {
    const input = { body: "hello" };
    const deliveryError = new SessionCommentDeliveryError(
      "local-comment-1",
      input,
      new Org2CloudCommentError("ORG2_SESSION_NOT_FOUND", 404)
    );
    const add = vi.fn(async () => {
      throw deliveryError;
    });
    const repair = vi.fn(async () => undefined);
    const retried = { id: "comment-1" } as never;
    const retryRetained = vi.fn(async () => retried);

    await expect(
      addCommentWithSessionAdmissionRecovery(add, repair, retryRetained)
    ).resolves.toBe(retried);
    expect(add).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(retryRetained).toHaveBeenCalledWith(deliveryError);
  });

  it("does not recreate a missing imported teammate session", async () => {
    const error = new Org2CloudCommentError("ORG2_SESSION_NOT_FOUND", 404);
    const add = vi.fn(async () => {
      throw error;
    });

    await expect(
      addCommentWithSessionAdmissionRecovery(add, null)
    ).rejects.toBe(error);
    expect(add).toHaveBeenCalledOnce();
  });

  it("preserves retained delivery ownership when admission repair fails", async () => {
    const input = { body: "hello" };
    const deliveryError = new SessionCommentDeliveryError(
      "local-comment-1",
      input,
      new Org2CloudCommentError("ORG2_SESSION_NOT_FOUND", 404)
    );
    const repairError = new Error("push failed");
    const add = vi.fn(async () => {
      throw deliveryError;
    });

    await expect(
      addCommentWithSessionAdmissionRecovery(add, async () => {
        throw repairError;
      })
    ).rejects.toMatchObject({
      name: "SessionCommentDeliveryError",
      commentId: "local-comment-1",
      cause: repairError,
    });
  });
});
