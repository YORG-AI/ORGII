import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  CLOUD_CONVERSATION_MAX_EVENT_BYTES,
  CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES,
  type CloudConversationEvent,
  type ListConversationEventsResult,
  Org2CloudConversationError,
  boundConversationEventForPush,
  conversationEventsForPush,
  decodeConversationEventChunks,
  listConversationEvents,
} from "./org2CloudConversationEventsClient";

function event(displayText: string): SessionEvent {
  return {
    id: "event-1",
    chunk_id: "event-1",
    sessionId: "session-1",
    createdAt: "2026-08-26T00:00:00.000Z",
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { message: { role: "user", content: displayText } },
    source: "user",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

describe("boundConversationEventForPush", () => {
  it("preserves exact events inside the wire limit", () => {
    const input = event("hello");
    expect(boundConversationEventForPush(input)).toBe(input);
  });

  it("fails closed instead of truncating native conversation history", () => {
    const input = event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES));
    expect(() => boundConversationEventForPush(input)).toThrow(
      Org2CloudConversationError
    );
    expect(() => boundConversationEventForPush(input)).toThrow(
      "ORG2_CONVERSATION_EVENT_TOO_LARGE"
    );
  });
});

function chunkRows(chunks: readonly SessionEvent[]): CloudConversationEvent[] {
  return chunks.map((chunk, index) => ({
    id: `wire-${index}`,
    rootSessionId: "session-1",
    authorUserId: "user-1",
    turnId: "turn-1",
    seq: index + 1,
    event: chunk,
    createdAt: "2026-08-26T00:00:00.000Z",
  }));
}

function patchChunkMetadata(
  row: CloudConversationEvent,
  patch: Record<string, unknown>
): CloudConversationEvent {
  const current = row.event.args.conversationEventChunk as Record<
    string,
    unknown
  >;
  return {
    ...row,
    event: {
      ...row.event,
      args: {
        ...row.event.args,
        conversationEventChunk: { ...current, ...patch },
      },
    },
  };
}

describe("conversation event chunk codec", () => {
  it("round-trips a valid oversized SessionEvent", async () => {
    const input = event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES));
    const rows = chunkRows(await conversationEventsForPush(input));

    await expect(decodeConversationEventChunks(rows)).resolves.toEqual([
      expect.objectContaining({ id: input.id, event: input }),
    ]);
  });

  it("rejects duplicate or missing chunk indices", async () => {
    const chunks = await conversationEventsForPush(
      event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES))
    );
    const rows = chunkRows(chunks);
    rows[1] = patchChunkMetadata(rows[1], { chunkIndex: 0 });

    await expect(decodeConversationEventChunks(rows)).rejects.toThrow(
      "duplicate or missing chunk indices"
    );
  });

  it("rejects inconsistent metadata within one logical event", async () => {
    const chunks = await conversationEventsForPush(
      event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES))
    );
    const rows = chunkRows(chunks);
    const metadata = rows[1].event.args.conversationEventChunk as {
      byteLength: number;
    };
    rows[1] = patchChunkMetadata(rows[1], {
      byteLength: metadata.byteLength - 1,
    });

    await expect(decodeConversationEventChunks(rows)).rejects.toThrow(
      "inconsistent conversation event chunk metadata"
    );
  });

  it("quarantines an oversized declared event instead of allocating its buffer", async () => {
    const chunks = await conversationEventsForPush(
      event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES))
    );
    const rows = chunkRows(chunks).map((row) =>
      patchChunkMetadata(row, {
        byteLength: CLOUD_CONVERSATION_MAX_LOGICAL_EVENT_BYTES + 1,
      })
    );

    await expect(decodeConversationEventChunks(rows)).resolves.toEqual([]);
  });

  it("quarantines a malformed chunk envelope without dropping its neighbours", async () => {
    const chunks = await conversationEventsForPush(
      event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES))
    );
    const rows = chunkRows(chunks).map((row) =>
      patchChunkMetadata(row, { sha256: "not-a-digest" })
    );
    const ordinary: CloudConversationEvent = {
      id: "wire-plain",
      rootSessionId: "session-1",
      authorUserId: "user-1",
      turnId: "turn-1",
      seq: 99,
      event: event("readable"),
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    await expect(
      decodeConversationEventChunks([...rows, ordinary])
    ).resolves.toEqual([ordinary]);
  });

  it("rejects an oversized encoded part before base64 decoding", async () => {
    const chunks = await conversationEventsForPush(
      event("x".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES))
    );
    const rows = chunkRows(chunks);
    rows[0] = {
      ...rows[0],
      event: {
        ...rows[0].event,
        result: { data: "A".repeat(CLOUD_CONVERSATION_MAX_EVENT_BYTES) },
      },
    };

    await expect(decodeConversationEventChunks(rows)).rejects.toThrow(
      "encoded part limit"
    );
  });
});

describe("conversation event wire validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubListing(events: readonly unknown[], hasMore = false): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ events, hasMore }), { status: 200 })
      )
    );
  }

  function wireRow(seq: number, payload: unknown): unknown {
    return {
      id: `wire-${seq}`,
      rootSessionId: "session-1",
      authorUserId: "user-1",
      turnId: "turn-1",
      seq,
      event: payload,
      createdAt: "2026-08-26T00:00:00.000Z",
    };
  }

  function list(): Promise<ListConversationEventsResult> {
    return listConversationEvents(
      "token",
      { orgId: "org-1", rootSessionId: "session-1" },
      { supabaseUrl: "https://cloud.invalid", anonKey: "anon" }
    );
  }

  it("quarantines a durable row whose event is not a canonical SessionEvent", async () => {
    const readable = event("readable");
    stubListing([wireRow(1, { id: "poison" }), wireRow(2, readable)]);

    await expect(list()).resolves.toEqual({
      events: [expect.objectContaining({ id: "wire-2", event: readable })],
      hasMore: false,
      lastSeq: 2,
      quarantined: 1,
    });
  });

  it("advances the wire cursor across a page of only poisoned rows", async () => {
    stubListing([wireRow(7, { id: "poison" }), wireRow(8, null)], true);

    await expect(list()).resolves.toEqual({
      events: [],
      hasMore: true,
      lastSeq: 8,
      quarantined: 2,
    });
  });

  it("still fails closed when the listing envelope itself is unreadable", async () => {
    stubListing([{ id: "wire-1", seq: "not-a-number" }]);

    await expect(list()).rejects.toThrow(
      "unparseable cloud_list_conversation_events payload"
    );
  });
});
