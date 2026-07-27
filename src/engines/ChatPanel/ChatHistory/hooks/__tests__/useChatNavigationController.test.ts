import { describe, expect, it } from "vitest";

import {
  resolveConversationHistoryPageIndex,
  resolveConversationHistorySelection,
  resolvePendingReplayNavigation,
} from "../useChatNavigationController";

const pages = [
  {
    startGroupIndex: 0,
    endGroupIndex: 1,
    flatStartIndex: 0,
    flatEndIndex: 3,
    replayTurnSummary: null,
    replayBodyLoaded: false,
  },
  {
    startGroupIndex: 2,
    endGroupIndex: 4,
    flatStartIndex: 3,
    flatEndIndex: 8,
    replayTurnSummary: null,
    replayBodyLoaded: false,
  },
];

describe("resolveConversationHistoryPageIndex", () => {
  it("uses the selected page when turn pagination is enabled", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 0,
        currentPageIndex: 1,
        pageIndexByGroupIndex: new Map([
          [0, 0],
          [1, 0],
          [2, 1],
          [3, 1],
          [4, 1],
        ]),
        pages,
        turnPaginationEnabled: true,
      })
    ).toBe(1);
  });

  it("maps the active visible group to a history page", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 3,
        currentPageIndex: 0,
        pageIndexByGroupIndex: new Map([
          [0, 0],
          [1, 0],
          [2, 1],
          [3, 1],
          [4, 1],
        ]),
        pages,
        turnPaginationEnabled: false,
      })
    ).toBe(1);
  });

  it("falls back to the latest page when no page contains the group", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 99,
        currentPageIndex: 0,
        pageIndexByGroupIndex: new Map(),
        pages,
        turnPaginationEnabled: false,
      })
    ).toBe(1);
  });

  it("does not scan every virtual replay page to resolve the visible group", () => {
    const virtualPagesTarget = [] as typeof pages;
    virtualPagesTarget.length = 1_000_000;
    const virtualPages = new Proxy(virtualPagesTarget, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
          throw new Error(`unexpected virtual page read: ${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 42,
        currentPageIndex: 0,
        pageIndexByGroupIndex: new Map([[42, 777_777]]),
        pages: virtualPages,
        turnPaginationEnabled: false,
      })
    ).toBe(777_777);
  });
});

describe("resolveConversationHistorySelection", () => {
  it("navigates directly when the selected round body is already rendered", () => {
    expect(
      resolveConversationHistorySelection({
        startGroupIndex: 7,
        endGroupIndex: 7,
        flatStartIndex: 20,
        flatEndIndex: 24,
        replayTurnSummary: {
          turnId: "provider-turn",
          renderedUserEventId: "provider-user",
          nextTurnId: null,
          turnIndex: 3,
          startedAt: "2026-07-26T01:00:00Z",
          endedAt: "2026-07-26T01:00:01Z",
          durationMs: 1,
          userPreview: "loaded prompt",
          eventCount: 4,
          bodyEventCount: 4,
        },
        replayBodyLoaded: true,
      })
    ).toEqual({
      kind: "navigate",
      groupIndex: 7,
      turnId: "provider-user",
    });
  });

  it("loads the exact compact replay round instead of navigating to sentinel group zero", () => {
    expect(
      resolveConversationHistorySelection({
        startGroupIndex: 0,
        endGroupIndex: -1,
        flatStartIndex: 0,
        flatEndIndex: 0,
        replayTurnSummary: {
          turnId: "__external_replay_turn_index__:42",
          renderedUserEventId: null,
          nextTurnId: null,
          turnIndex: 42,
          startedAt: "2026-07-26T01:00:00Z",
          endedAt: "2026-07-26T01:00:01Z",
          durationMs: 1,
          userPreview: "unloaded prompt",
          eventCount: 4,
          bodyEventCount: 4,
        },
        replayBodyLoaded: false,
      })
    ).toEqual({ kind: "load-replay", turnIndex: 42 });
  });
});

describe("resolvePendingReplayNavigation", () => {
  const pending = {
    episodeId: 7,
    generation: "generation-a",
    pageIndex: 3,
    sessionId: "codexapp-session",
    turnIndex: 42,
  };
  const loadedPage = {
    startGroupIndex: 5,
    endGroupIndex: 5,
    flatStartIndex: 12,
    flatEndIndex: 16,
    replayTurnSummary: {
      turnId: "provider-turn-42",
      renderedUserEventId: "provider-user-42",
      nextTurnId: "provider-turn-43",
      turnIndex: 42,
      startedAt: "2026-07-26T01:00:00Z",
      endedAt: "2026-07-26T01:00:01Z",
      durationMs: 1_000,
      userPreview: "old prompt",
      eventCount: 4,
      bodyEventCount: 3,
    },
    replayBodyLoaded: true,
  };

  it("automatically resolves the rendered group when the exact old-round body arrives", () => {
    expect(
      resolvePendingReplayNavigation({
        activeId: "codexapp-session",
        episode: { id: 7, generation: "generation-a" },
        page: loadedPage,
        pending,
      })
    ).toEqual({
      kind: "navigate",
      groupIndex: 5,
      turnId: "provider-user-42",
    });
  });

  it("waits for projection instead of navigating to an unrelated resident group", () => {
    expect(
      resolvePendingReplayNavigation({
        activeId: "codexapp-session",
        episode: { id: 7, generation: "generation-a" },
        page: { ...loadedPage, replayBodyLoaded: false },
        pending,
      })
    ).toEqual({ kind: "wait" });
  });

  it("cancels a late result from a replaced replay episode", () => {
    expect(
      resolvePendingReplayNavigation({
        activeId: "codexapp-session",
        episode: { id: 8, generation: "generation-b" },
        page: loadedPage,
        pending,
      })
    ).toEqual({ kind: "cancel" });
  });
});
