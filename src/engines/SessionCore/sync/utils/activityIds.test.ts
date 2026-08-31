/**
 * Uniqueness contract for the TS-side streaming placeholder ids.
 *
 * `createStreamMessageId` / `createStreamThinkingId` mint the id that keys a
 * live transcript event in the event store. The store UPSERTs on that id, so
 * two placeholders that collide are not two events — they are one event whose
 * text is overwritten by the later stream. That silently merges two logically
 * distinct streams into a single transcript row.
 *
 * The ids therefore have to stay distinct even when minted inside the same
 * millisecond, which is exactly what a fast `reset()` → next-delta sequence
 * does. The clock is pinned below so "same millisecond" is guaranteed rather
 * than hoped for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStreamMessageId,
  createStreamThinkingId,
  extractOriginalChunkId,
  isStreamingId,
  parseActivityId,
} from "./activityIds";

const SESSION_ID = "session-under-test";

describe("stream placeholder ids", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each([
    ["createStreamMessageId", createStreamMessageId, "stream-msg-ts-"],
    ["createStreamThinkingId", createStreamThinkingId, "stream-think-ts-"],
  ] as const)("%s", (_name, createId, prefix) => {
    it("mints distinct ids for the same session within one millisecond", () => {
      const ids = Array.from({ length: 1000 }, () => createId(SESSION_ID));

      // The clock never advanced, so any uniqueness has to come from the id
      // itself rather than from Date.now().
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("mints distinct ids across both lanes and repeated sessions", () => {
      const ids = [
        createId(SESSION_ID),
        createId(SESSION_ID),
        createId("other-session"),
        createId(SESSION_ID),
      ];

      expect(new Set(ids).size).toBe(ids.length);
    });

    it("keeps the prefix that Rust and the e2e suite match on", () => {
      // src-tauri/crates/session-persistence/src/crud.rs::is_ts_placeholder_id
      // and subagent_handler/persistence.rs both use this exact prefix to keep
      // live-only placeholders out of the DB.
      expect(createId(SESSION_ID).startsWith(prefix)).toBe(true);
      expect(isStreamingId(createId(SESSION_ID))).toBe(true);
    });

    it("stays colon-free so parseActivityId classification is unchanged", () => {
      // A colon would make parseActivityId treat the id as a structured
      // prefix:source:identifier triple, and extractOriginalChunkId — used for
      // dedup by isSameId/matchesId — would then return only a fragment.
      // See features/TeamCollaboration/copyEventId.ts for the same constraint.
      const id = createId(SESSION_ID);

      expect(id).not.toContain(":");
      expect(parseActivityId(id).isValid).toBe(false);
      expect(extractOriginalChunkId(id)).toBe(id);
    });

    it("orders lexicographically by creation order within one millisecond", () => {
      // compareChatEvents (core/store/snapshotMaterialization.orderMembership)
      // falls back to id.localeCompare when createdAt ties, which two
      // same-millisecond placeholders routinely do.
      const ids = Array.from({ length: 50 }, () => createId(SESSION_ID));

      expect([...ids].sort((left, right) => left.localeCompare(right))).toEqual(
        ids
      );
    });
  });

  it("never collides between the message and thinking lanes", () => {
    const ids = [
      createStreamMessageId(SESSION_ID),
      createStreamThinkingId(SESSION_ID),
      createStreamMessageId(SESSION_ID),
      createStreamThinkingId(SESSION_ID),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });
});
