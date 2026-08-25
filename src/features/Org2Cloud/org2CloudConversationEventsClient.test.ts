import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  type CloudConversationEvent,
  listConversationEventsFrom,
  retainConversationEventTail,
} from "./org2CloudConversationEventsClient";

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function row(seq: number): CloudConversationEvent {
  return {
    id: `row-${seq}`,
    rootSessionId: "root",
    authorUserId: "user",
    turnId: `turn-${seq}`,
    seq,
    event: { id: `event-${seq}` } as SessionEvent,
    createdAt: "2026-08-25T00:00:00Z",
  };
}

function wireRow(seq: number) {
  const value = row(seq);
  return { ...value, event: value.event };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("retainConversationEventTail", () => {
  it("keeps prompt memory bounded across pages", () => {
    const first = retainConversationEventTail(
      [],
      Array.from({ length: 50 }, (_, index) => row(index + 1)),
      60
    );
    const second = retainConversationEventTail(
      first,
      Array.from({ length: 50 }, (_, index) => row(index + 51)),
      60
    );

    expect(second).toHaveLength(60);
    expect(second[0].seq).toBe(41);
    expect(second.at(-1)?.seq).toBe(100);
  });

  it("rejects an invalid retention bound", () => {
    expect(() => retainConversationEventTail([], [], 0)).toThrow(
      "retainLast must be a positive integer"
    );
  });
});

describe("listConversationEventsFrom", () => {
  it("traverses every page while retaining only the newest prompt rows", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          events: [wireRow(1), wireRow(2)],
          hasMore: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ events: [wireRow(3)], hasMore: false })
      );

    const result = await listConversationEventsFrom("jwt", {
      orgId: "org",
      rootSessionId: "root",
      afterSeq: 0,
      retainLast: 2,
    });

    expect(result.lastSeq).toBe(3);
    expect(result.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body))
    ) as Array<Record<string, unknown>>;
    expect(bodies.map((body) => body.p_after_seq)).toEqual([0, 2]);
  });

  it("rejects a non-increasing server sequence", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ events: [wireRow(4)], hasMore: false })
    );

    await expect(
      listConversationEventsFrom("jwt", {
        orgId: "org",
        rootSessionId: "root",
        afterSeq: 4,
      })
    ).rejects.toThrow("event sequence");
  });
});
