import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  buildChatSearchableText,
  mapRustResultsToSearchResults,
  searchChatHistoryLocally,
  wrapNextSearchResultIndex,
} from "../chatSearchHelpers";

function event(id: string, chunkId: string | null = id): SessionEvent {
  return {
    chunk_id: chunkId,
    id,
    sessionId: "session-1",
    createdAt: "2026-08-25T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: {},
    source: "assistant",
    displayText: `text-${id}`,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

describe("chatSearchHelpers", () => {
  it("maps rust results onto chat history items by event id", () => {
    const history = [event("a"), event("b")];
    const mapped = mapRustResultsToSearchResults(
      [{ eventId: "b", chatIndex: 0, score: 4, snippet: "hit" }],
      history
    );

    expect(mapped).toEqual([
      {
        item: history[1],
        index: 1,
        score: 4,
        snippet: "hit",
      },
    ]);
  });

  it("falls back to rust chatIndex when event id is missing", () => {
    const history = [event("a"), event("b")];
    const mapped = mapRustResultsToSearchResults(
      [{ eventId: "missing", chatIndex: 1, score: 1, snippet: "..." }],
      history
    );

    expect(mapped[0]?.index).toBe(1);
  });

  it("wraps result navigation forward and backward", () => {
    expect(wrapNextSearchResultIndex(0, 3, 1)).toBe(1);
    expect(wrapNextSearchResultIndex(2, 3, 1)).toBe(0);
    expect(wrapNextSearchResultIndex(0, 3, -1)).toBe(2);
  });

  it("builds searchable text from event fields", () => {
    const history = [
      {
        ...event("a"),
        result: { content: "比较 Codex 网页与 org2 方案" },
        displayText: "",
      },
    ];
    expect(buildChatSearchableText(history[0]!)).toContain("网页");
  });

  it("searches loaded chat history when rust mapping would be empty", () => {
    const history = [
      {
        ...event("a"),
        result: { content: "hello world" },
        displayText: "",
      },
      {
        ...event("b"),
        result: { content: "比较 Codex 网页与 org2 方案" },
        displayText: "",
      },
    ];

    const results = searchChatHistoryLocally(
      history,
      "网页",
      {
        caseSensitive: false,
        useRegex: false,
        wholeWord: false,
      },
      10
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.item.id).toBe("b");
    expect(results[0]?.snippet).toContain("网页");
  });
});
