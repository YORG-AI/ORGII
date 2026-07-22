import { describe, expect, it } from "vitest";

import { resolveConversationHistoryPageIndex } from "../useChatNavigationController";

const pages = [
  {
    startGroupIndex: 0,
    endGroupIndex: 1,
    flatStartIndex: 0,
    flatEndIndex: 3,
    cursorIdeSummary: null,
    cursorIdeBodyLoaded: false,
  },
  {
    startGroupIndex: 2,
    endGroupIndex: 4,
    flatStartIndex: 3,
    flatEndIndex: 8,
    cursorIdeSummary: null,
    cursorIdeBodyLoaded: false,
  },
];

describe("resolveConversationHistoryPageIndex", () => {
  it("uses the selected page when turn pagination is enabled", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 0,
        currentPageIndex: 1,
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
        pages,
        turnPaginationEnabled: false,
      })
    ).toBe(1);
  });
});
